import asyncio
import random

WAKEUP_SOUNDS = [
    "/usr/share/sound-vendor/AiNiRobot/wakeup_ei_01.wav",
    "/usr/share/sound-vendor/AiNiRobot/wakeup_zai_01.wav",
    "/usr/share/sound-vendor/AiNiRobot/wakeup_wozai.wav",
]


async def before_wakeup(speaker, text, source):
    if source == "kws":
        sound = random.choice(WAKEUP_SOUNDS)
        await speaker.run_shell(
            "ubus call mediaplayer player_play_url "
            f"'{{\"url\":\"file://{sound}\",\"type\":1}}'"
        )
        await asyncio.sleep(0.8)
        await speaker.run_shell("/bin/show_led 1")
        return True

    return False


async def after_wakeup(speaker):
    # 灭灯
    await speaker.run_shell("/bin/shut_led 1")


APP_CONFIG = {
    "wakeup": {
        "keywords": [
            "你好小蜜",
        ],
        "timeout": 8,
        "multiturn_timeout": 8,
        "before_wakeup": before_wakeup,
        "after_wakeup": after_wakeup,
    },
    "beep": {
        "enabled": True,
        "sound": "/usr/share/common_sound/multirounds_tone.opus",
    },
    "vad": {
        "threshold": 0.30,             # 提高阈值，避免 TTS 余音/环境噪声误触发
        "min_speech_duration": 500,    # 至少 500ms 持续语音才算有效，过滤短促噪声
        "min_silence_duration": 700,   # 静音 700ms 才算说话结束，避免过早截断
        "debounce_duration": 400,      # VAD 启动后 400ms 内忽略所有帧，等 TTS 余音消散
    },
}
