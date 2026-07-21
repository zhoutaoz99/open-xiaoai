import base64
import io
import logging
import wave

import aiohttp

logger = logging.getLogger(__name__)


def _pcm_to_wav(pcm_data: bytes, sample_rate: int, channels: int, bits_per_sample: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(bits_per_sample // 8)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_data)
    return buf.getvalue()


def _encode_data_url(wav_data: bytes) -> str:
    b64 = base64.b64encode(wav_data).decode("ascii")
    return f"data:audio/wav;base64,{b64}"


class MiMoASR:
    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.xiaomimimo.com/v1",
        language: str = "zh",
    ):
        self.api_key = api_key
        self.base_url = base_url
        self.language = language

    async def transcribe(
        self,
        pcm_data: bytes,
        sample_rate: int = 16000,
        channels: int = 1,
        bits_per_sample: int = 16,
    ) -> str:
        if not self.api_key:
            raise RuntimeError("MIMO_API_KEY 未配置，无法调用 ASR")

        wav_data = _pcm_to_wav(pcm_data, sample_rate, channels, bits_per_sample)
        data_url = _encode_data_url(wav_data)

        payload = {
            "model": "mimo-v2.5-asr",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_audio",
                            "input_audio": {"data": data_url},
                        }
                    ],
                }
            ],
            "asr_options": {"language": self.language},
        }

        headers = {
            "api-key": self.api_key,
            "Content-Type": "application/json",
        }

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.base_url}/chat/completions",
                json=payload,
                headers=headers,
            ) as resp:
                text = await resp.text()
                if resp.status != 200:
                    logger.error(f"ASR HTTP {resp.status}: {text[:300]}")
                    raise RuntimeError(
                        f"MiMo ASR 请求失败 (HTTP {resp.status}): {text[:200]}"
                    )

                import json
                data = json.loads(text)
                if "error" in data:
                    msg = data["error"].get("message", str(data["error"]))
                    logger.error(f"ASR API error: {msg}")
                    raise RuntimeError(f"MiMo ASR 返回错误: {msg}")

                if "choices" not in data:
                    logger.error(f"ASR 响应缺少 choices 字段: {text[:300]}")
                    raise RuntimeError(
                        f"MiMo ASR 响应格式异常: {text[:200]}"
                    )

                content = data["choices"][0]["message"]["content"]
                return content
