import math
import struct

TARGET_RATE = 24000


def generate_beep(
    freq: int = 1000,
    duration_ms: int = 150,
    sample_rate: int = TARGET_RATE,
    volume: float = 0.4,
    fade_ms: int = 10,
) -> bytes:
    num_samples = int(sample_rate * duration_ms / 1000)
    fade_samples = int(sample_rate * fade_ms / 1000)
    buf = bytearray(num_samples * 2)

    for i in range(num_samples):
        envelope = 1.0
        if i < fade_samples:
            envelope = i / fade_samples
        elif i > num_samples - fade_samples:
            envelope = (num_samples - i) / fade_samples
        value = int(volume * envelope * 32767 * math.sin(2 * math.pi * freq * i / sample_rate))
        struct.pack_into("<h", buf, i * 2, value)

    return bytes(buf)
