import base64
import json
import logging

import aiohttp

logger = logging.getLogger(__name__)


class MiMoTTS:
    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.xiaomimimo.com/v1",
        model: str = "mimo-v2.5-tts",
        voice: str = "mimo_default",
    ):
        self.api_key = api_key
        self.base_url = base_url
        self.model = model
        self.voice = voice

    async def synthesize(self, text: str) -> bytes:
        if not self.api_key:
            raise RuntimeError("MIMO_API_KEY 未配置，无法调用 TTS")

        payload = {
            "model": self.model,
            "messages": [
                {"role": "assistant", "content": text},
            ],
            "audio": {
                "format": "pcm16",
                "voice": self.voice,
            },
        }
        headers = {
            "api-key": self.api_key,
            "Content-Type": "application/json",
        }

        all_audio: list[bytes] = []

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.base_url}/chat/completions",
                json={**payload, "stream": True},
                headers=headers,
            ) as resp:
                if resp.status != 200:
                    body = await resp.text()
                    logger.error(f"TTS HTTP {resp.status}: {body[:300]}")
                    raise RuntimeError(
                        f"MiMo TTS 请求失败 (HTTP {resp.status}): {body[:200]}"
                    )

                async for line in resp.content:
                    line = line.decode("utf-8").strip()
                    if not line.startswith("data: "):
                        continue
                    data_str = line[6:]
                    if data_str == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data_str)
                    except json.JSONDecodeError as e:
                        logger.warning(f"TTS 跳过无法解析的行: {e}: {data_str[:120]}")
                        continue

                    if "error" in chunk:
                        msg = chunk["error"].get("message", str(chunk["error"]))
                        logger.error(f"TTS API error: {msg}")
                        raise RuntimeError(f"MiMo TTS 返回错误: {msg}")

                    # choices/delta/audio 字段可能为 None（首帧/尾帧），
                    # 用 `or {}` 兜底，避免 None.get() 抛 AttributeError
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    audio = delta.get("audio") or {}
                    audio_data = audio.get("data")
                    if audio_data:
                        all_audio.append(base64.b64decode(audio_data))

        return b"".join(all_audio)
