import asyncio
import logging

from aiohttp import web

from xiaozhi.ref import get_speaker
from xiaozhi.services.audio.stream import GlobalStream
from xiaozhi.services.tts import MiMoTTS
from xiaozhi.utils.base import get_env

logger = logging.getLogger(__name__)


class PushServer:
    def __init__(self):
        self.port = int(get_env("AGENT_PUSH_PORT", "4400"))
        self.host = get_env("AGENT_PUSH_HOST", "0.0.0.0")
        self.api_key = get_env("AGENT_PUSH_API_KEY", "") or None
        self.tts = MiMoTTS(
            api_key=get_env("MIMO_API_KEY", ""),
            base_url=get_env("TTS_BASE_URL", "https://api.xiaomimimo.com/v1"),
            model=get_env("TTS_MODEL", "mimo-v2.5-tts"),
            voice=get_env("TTS_VOICE", "mimo_default"),
        )
        self._runner: web.AppRunner | None = None

    async def start(self):
        app = web.Application()
        app.router.add_get("/health", self._handle_health)
        app.router.add_post("/push", self._handle_push)

        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self.host, self.port)
        await site.start()
        logger.info(f"✅ 提醒推送服务已启动: {self.host}:{self.port}")
        if not self.api_key:
            logger.warning("⚠️ 提醒推送服务未配置密钥，同网络下任何人都能让音箱说话")

    async def stop(self):
        if self._runner:
            await self._runner.cleanup()
            self._runner = None

    async def _handle_health(self, request: web.Request) -> web.Response:
        return web.json_response({"status": "ok"})

    async def _handle_push(self, request: web.Request) -> web.Response:
        if self.api_key:
            auth = request.headers.get("Authorization", "")
            if auth != f"Bearer {self.api_key}":
                return web.json_response(
                    {"ok": False, "error": "unauthorized"}, status=401
                )

        try:
            body = await request.json()
        except Exception:
            return web.json_response(
                {"ok": False, "error": "invalid json"}, status=400
            )

        text = body.get("text")
        url = body.get("url")
        if not text and not url:
            return web.json_response(
                {"ok": False, "error": "text or url is required"}, status=400
            )

        logger.info(f"🔔 {url or text}")
        asyncio.ensure_future(self._play(text, url))
        return web.json_response({"ok": True}, status=202)

    async def _play(self, text: str | None, url: str | None):
        try:
            if url:
                speaker = get_speaker()
                if speaker:
                    await speaker.play(url=url, blocking=True)
                return

            audio = await self.tts.synthesize(text)
            if audio:
                GlobalStream.output(audio)
                duration = len(audio) / (24000 * 2)
                await asyncio.sleep(duration)
        except Exception as e:
            logger.error(f"❌ 提醒播报失败: {e}")
