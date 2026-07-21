import asyncio
import threading
import time

from config import APP_CONFIG
from xiaozhi.event import EventManager
from xiaozhi.pipeline import AgentConnector, Pipeline
from xiaozhi.ref import get_speaker, get_xiaoai, set_xiaozhi
from xiaozhi.services.asr import MiMoASR
from xiaozhi.services.audio.kws import KWS
from xiaozhi.services.audio.stream import GlobalStream
from xiaozhi.services.audio.vad import VAD
from xiaozhi.services.protocols.typing import DeviceState
from xiaozhi.services.push import PushServer
from xiaozhi.services.tts import MiMoTTS
from xiaozhi.utils.audio import generate_beep
from xiaozhi.utils.base import get_env
from xiaozhi.xiaoai import XiaoAI


class XiaoZhi:
    _instance = None

    @classmethod
    def instance(cls):
        if cls._instance is None:
            cls._instance = XiaoZhi()
        return cls._instance

    def __init__(self):
        if XiaoZhi._instance is not None:
            raise Exception("XiaoZhi is singleton")
        XiaoZhi._instance = self

        self.device_state = DeviceState.IDLE
        self.current_text = ""
        self.loop = asyncio.new_event_loop()
        self.running = False
        self.pipeline: Pipeline | None = None
        self.push_server: PushServer | None = None
        self.display = None
        self._wakeup_gen = 0

        set_xiaozhi(self)

    def run(self):
        self.running = True

        asr = MiMoASR(
            api_key=get_env("MIMO_API_KEY", ""),
            base_url=get_env("ASR_BASE_URL", "https://api.xiaomimimo.com/v1"),
            language=get_env("ASR_LANGUAGE", "zh"),
        )

        agent = AgentConnector(
            base_url=get_env("ASSISTANT_BASE_URL", "http://127.0.0.1:8000"),
            session_id=get_env("ASSISTANT_SESSION_ID", "default"),
            api_key=get_env("ASSISTANT_API_KEY", "") or None,
            stream=get_env("ASSISTANT_STREAM", "true").lower() == "true",
            timeout=float(get_env("ASSISTANT_TIMEOUT", "30")),
        )

        tts = MiMoTTS(
            api_key=get_env("MIMO_API_KEY", ""),
            base_url=get_env("TTS_BASE_URL", "https://api.xiaomimimo.com/v1"),
            model=get_env("TTS_MODEL", "mimo-v2.5-tts"),
            voice=get_env("TTS_VOICE", "mimo_default"),
        )

        self.pipeline = Pipeline(asr=asr, agent=agent, tts=tts)

        loop_thread = threading.Thread(target=self._run_event_loop, daemon=True)
        loop_thread.start()
        time.sleep(0.1)

        asyncio.run_coroutine_threadsafe(XiaoAI.init_xiaoai(), self.loop)
        asyncio.run_coroutine_threadsafe(self._init(), self.loop)

        VAD.start()
        KWS.start()

        if get_env("CLI"):
            self._init_display()

        if self.display:
            self.display.start()
        else:
            while self.running:
                time.sleep(1)

    def _run_event_loop(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    async def _init(self):
        self.push_server = PushServer()
        await self.push_server.start()

    def _init_display(self):
        try:
            from xiaozhi.services.display import no_display

            self.display = no_display.NoDisplay()
            self.display.update_status("待命")
        except Exception:
            pass

    def on_wakeup(self, pcm_data: bytes):
        asyncio.run_coroutine_threadsafe(self._handle_wakeup(pcm_data), self.loop)

    async def _handle_wakeup(self, pcm_data: bytes):
        self._wakeup_gen += 1
        gen = self._wakeup_gen

        if self.device_state == DeviceState.SPEAKING:
            self.pipeline.cancel()
            self.device_state = DeviceState.IDLE

        self.device_state = DeviceState.LISTENING
        if self.display:
            self.display.update_status("识别中...")

        reply_audio: bytes | None = None

        def on_text(t: str):
            self.current_text = t
            if self.display:
                self.display.update_text(f"🤖 {t}")

        def on_audio(audio: bytes):
            nonlocal reply_audio
            reply_audio = audio

        ok = await self.pipeline.run(pcm_data, on_reply_text=on_text, on_reply_audio=on_audio)

        if gen != self._wakeup_gen:
            return

        if reply_audio:
            await self._play_audio(reply_audio)

        if gen != self._wakeup_gen:
            return

        await self._play_beep()

        if gen != self._wakeup_gen:
            return

        asyncio.run_coroutine_threadsafe(
            EventManager.continue_listening(),
            get_xiaoai().async_loop,
        )

    async def _play_audio(self, audio: bytes):
        self.device_state = DeviceState.SPEAKING
        if self.display:
            self.display.update_status("说话中...")

        GlobalStream.output(audio)

        duration = len(audio) / (24000 * 2)
        await asyncio.sleep(duration)

    async def _play_beep(self):
        cfg = APP_CONFIG.get("beep", {})
        if not cfg.get("enabled", False):
            return

        sound = cfg.get("sound", "/usr/share/common_sound/multirounds_tone.opus")
        speaker = get_speaker()
        if speaker:
            res = await speaker.run_shell(f"qplayer {sound}", timeout=5000)
            if res.exit_code == 0:
                return

        beep = generate_beep()
        GlobalStream.output(beep)
        await asyncio.sleep(len(beep) / (24000 * 2))

    def shutdown(self):
        self.running = False
        if self.push_server:
            asyncio.run_coroutine_threadsafe(self.push_server.stop(), self.loop)
        self.loop.call_soon_threadsafe(self.loop.stop)
