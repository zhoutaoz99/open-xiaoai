import asyncio
import os
import threading
import time

from config import APP_CONFIG
from xiaozhi.event import EventManager
from xiaozhi.ref import get_speaker, get_xiaoai, get_xiaozhi, set_kws
from xiaozhi.services.audio.kws.sherpa import SherpaOnnx
from xiaozhi.services.audio.stream import MyAudio
from xiaozhi.services.protocols.typing import AudioConfig, DeviceState
from xiaozhi.utils.base import get_env


class _KWS:
    def __init__(self):
        set_kws(self)

    def start(self):
        if not get_env("CLI"):
            return

        self.audio = MyAudio.create()
        self.stream = self.audio.open(
            format=AudioConfig.FORMAT,
            channels=1,
            rate=16000,
            input=True,
            frames_per_buffer=AudioConfig.FRAME_SIZE,
            start=True,
        )

        # 启动 KWS 服务
        self.paused = False
        self.thread = threading.Thread(target=self._detection_loop, daemon=True)
        self.thread.start()

    def get_file_path(self, file_name: str):
        current_dir = os.path.dirname(os.path.abspath(__file__))
        return os.path.join(current_dir, "../../../models", file_name)

    def pause(self):
        self.paused = True

    def resume(self):
        self.paused = False

    def reset(self):
        # 重置 KWS 内部状态，丢弃已缓存的音频（如 TTS 回音），
        # 避免 sherpa-onnx 流状态被污染导致后续唤醒词检测失败
        was = self.paused
        self.paused = True
        self.stream.flush()
        SherpaOnnx.reset()
        self.paused = was

    def _detection_loop(self):
        SherpaOnnx.start()
        self.stream.start_stream()
        while True:
            # 读取缓冲区音频数据
            frames = self.stream.read(
                AudioConfig.FRAME_SIZE, exception_on_overflow=False
            )

            # 在说话和监听状态时，暂停 KWS
            if (
                not frames
                or self.paused
                or get_xiaozhi().device_state
                in [
                    DeviceState.LISTENING,
                    DeviceState.SPEAKING,
                ]
            ):
                time.sleep(0.01)
                continue

            result = SherpaOnnx.kws(frames)
            if result:
                print(f"🔥 触发唤醒: {result}")
                self.on_message(result)

    def on_message(self, text: str):
        asyncio.run_coroutine_threadsafe(
            EventManager.wakeup(text, "kws"),
            get_xiaoai().async_loop,
        )


KWS = _KWS()
