import asyncio
import logging

from config import APP_CONFIG
from xiaozhi.ref import (
    get_audio_codec,
    get_kws,
    get_speaker,
    get_vad,
    get_xiaoai,
    get_xiaozhi,
)
from xiaozhi.services.audio.stream import MyAudio
from xiaozhi.services.protocols.typing import AudioConfig, DeviceState
from xiaozhi.utils.base import get_env

logger = logging.getLogger(__name__)


class __EventManager:
    def __init__(self):
        self.session_id = 0
        self._wake_future = None

    def on_interrupt(self):
        self.session_id += 1
        self._complete_future("interrupted")

    def on_speech(self, _speech_buffer: bytes):
        self._complete_future("speech")

    def on_silence(self):
        self._complete_future("silence")

    def _complete_future(self, result):
        if self._wake_future and not self._wake_future.done():
            get_xiaoai().async_loop.call_soon_threadsafe(
                self._wake_future.set_result, result
            )

    async def wakeup(self, text, source):
        get_kws().pause()

        speaker = get_speaker()
        wake = await APP_CONFIG["wakeup"]["before_wakeup"](speaker, text, source)

        get_kws().resume()

        if not wake:
            return

        get_xiaozhi().device_state = DeviceState.IDLE

        if not get_env("CLI"):
            return

        await self._capture_and_process(speaker)

    async def continue_listening(self):
        speaker = get_speaker()
        xiaozhi = get_xiaozhi()
        timeout = APP_CONFIG["wakeup"]["multiturn_timeout"]

        xiaozhi.device_state = DeviceState.LISTENING
        await self._capture_and_process(speaker, timeout=timeout)

    async def _capture_and_process(self, speaker, timeout=None):
        loop = asyncio.get_running_loop()
        vad = get_vad()
        codec = get_audio_codec()
        xiaozhi = get_xiaozhi()
        if timeout is None:
            timeout = APP_CONFIG["wakeup"]["timeout"]

        if codec is None:
            audio = MyAudio.create()
            capture_stream = audio.open(
                format=AudioConfig.FORMAT,
                channels=1,
                rate=AudioConfig.SAMPLE_RATE,
                input=True,
                frames_per_buffer=AudioConfig.FRAME_SIZE,
                start=True,
            )
        else:
            capture_stream = codec.input_stream

        capture_stream.start_stream()

        self._wake_future = loop.create_future()
        vad.resume("speech")

        try:
            result = await asyncio.wait_for(self._wake_future, timeout=timeout)
        except asyncio.TimeoutError:
            capture_stream.stop_stream()
            xiaozhi.device_state = DeviceState.IDLE
            await APP_CONFIG["wakeup"]["after_wakeup"](speaker)
            get_kws().reset()
            return

        if result != "speech":
            capture_stream.stop_stream()
            if result == "interrupted":
                return
            xiaozhi.device_state = DeviceState.IDLE
            await APP_CONFIG["wakeup"]["after_wakeup"](speaker)
            get_kws().reset()
            return

        self._wake_future = loop.create_future()
        vad.resume("silence")

        try:
            await asyncio.wait_for(self._wake_future, timeout=30)
        except asyncio.TimeoutError:
            pass

        vad.pause()

        all_pcm = capture_stream.read(None)
        capture_stream.stop_stream()

        if all_pcm:
            xiaozhi.on_wakeup(bytes(all_pcm))


EventManager = __EventManager()
