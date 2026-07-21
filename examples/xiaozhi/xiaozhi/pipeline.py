import asyncio
import json
import logging
import uuid

import aiohttp

from xiaozhi.services.asr import MiMoASR
from xiaozhi.services.tts import MiMoTTS

logger = logging.getLogger(__name__)


class AgentConnector:
    def __init__(
        self,
        base_url: str,
        session_id: str = "default",
        api_key: str | None = None,
        stream: bool = True,
        timeout: float = 10.0,
    ):
        self.base_url = base_url
        self.session_id = session_id
        self.api_key = api_key
        self.stream = stream
        self.timeout = timeout
        self._abort = False

    def cancel(self):
        self._abort = True

    async def chat(self, text: str) -> str:
        self._abort = False

        payload = {
            "request_id": str(uuid.uuid4()),
            "session_id": self.session_id,
            "text": text,
            "stream": self.stream,
        }
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        full_text = ""

        async with aiohttp.ClientSession() as session:
            try:
                async with session.post(
                    f"{self.base_url}/chat",
                    json=payload,
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=self.timeout),
                ) as resp:
                    if resp.status != 200:
                        logger.error(f"Agent returned {resp.status}")
                        return ""

                    if not self.stream:
                        data = await resp.json()
                        return data.get("text", "")

                    async for line in resp.content:
                        if self._abort:
                            break
                        line = line.decode("utf-8").strip()
                        if not line:
                            continue
                        if line.startswith("event: "):
                            event_type = line[7:]
                            continue
                        if line.startswith("data: "):
                            data_str = line[6:]
                            try:
                                data = json.loads(data_str)
                            except json.JSONDecodeError:
                                continue
                            if event_type == "delta":
                                full_text += data.get("text", "")
                            elif event_type == "done":
                                break
                            elif event_type == "error":
                                logger.error(f"Agent error: {data.get('message')}")
                                return data.get("text", "")
                            elif event_type == "fallback":
                                return ""

            except asyncio.TimeoutError:
                logger.error("Agent timeout")
            except aiohttp.ClientError as e:
                logger.error(f"Agent connection error: {e}")

        return full_text


class Pipeline:
    def __init__(
        self,
        asr: MiMoASR,
        agent: AgentConnector,
        tts: MiMoTTS,
    ):
        self.asr = asr
        self.agent = agent
        self.tts = tts
        self._current_task: asyncio.Task | None = None

    def cancel(self):
        self.agent.cancel()
        if self._current_task:
            self._current_task.cancel()

    async def run(
        self, pcm_data: bytes, on_reply_text: callable, on_reply_audio: callable
    ) -> bool:
        self._current_task = asyncio.current_task()

        try:
            text = await self.asr.transcribe(pcm_data)
            logger.info(f"ASR: {text}")
        except Exception as e:
            logger.error(f"ASR error: {type(e).__name__}: {e}")
            return False

        if not text:
            return False

        try:
            reply = await self.agent.chat(text)
            logger.info(f"Agent: {reply}")
        except Exception as e:
            logger.error(f"Agent error: {type(e).__name__}: {e}")
            return False

        if not reply:
            return False

        if on_reply_text:
            on_reply_text(reply)

        try:
            audio = await self.tts.synthesize(reply)
        except Exception as e:
            logger.error(f"TTS error: {type(e).__name__}: {e}")
            return False

        if on_reply_audio:
            on_reply_audio(audio)

        return True
