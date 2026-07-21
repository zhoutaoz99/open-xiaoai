import argparse
import asyncio
import threading

import numpy as np
import open_xiaoai_server

from xiaozhi.ref import get_speaker, set_xiaoai
from xiaozhi.services.audio.stream import GlobalStream
from xiaozhi.services.speaker import SpeakerManager

ASCII_BANNER = """
▄▖      ▖▖▘    ▄▖▄▖
▌▌▛▌█▌▛▌▚▘▌▀▌▛▌▌▌▐
▙▌▙▌▙▖▌▌▌▌▌█▌▙▌▛▌▟▖
  ▌

v2.0.0
"""


class XiaoAI:
    mode = "xiaoai"
    speaker = SpeakerManager()
    async_loop: asyncio.AbstractEventLoop = None

    @classmethod
    def setup_mode(cls):
        set_xiaoai(cls)
        parser = argparse.ArgumentParser(
            description="小爱音箱接入自定义语音助手"
        )
        parser.add_argument(
            "--mode",
            type=str,
            choices=["xiaoai", "xiaozhi"],
            default="xiaoai",
            help="运行模式：【xiaoai】使用小爱音箱的输入输出音频（默认）、【xiaozhi】使用本地电脑的输入输出音频",
        )
        args = parser.parse_args()
        if args.mode == "xiaozhi":
            cls.mode = "xiaozhi"

    @classmethod
    def on_input_data(cls, data: bytes):
        audio_array = np.frombuffer(data, dtype=np.uint16)
        GlobalStream.input(audio_array.tobytes())

    @classmethod
    def on_output_data(cls, data: bytes):
        async def on_output_data_async(data: bytes):
            return await open_xiaoai_server.on_output_data(data)

        asyncio.run_coroutine_threadsafe(
            on_output_data_async(data),
            cls.async_loop,
        )

    @classmethod
    async def run_shell(cls, script: str, timeout: float = 10 * 1000):
        return await open_xiaoai_server.run_shell(script, timeout)

    @classmethod
    def __init_background_event_loop(cls):
        def run_event_loop():
            cls.async_loop = asyncio.new_event_loop()
            asyncio.set_event_loop(cls.async_loop)
            cls.async_loop.run_forever()

        thread = threading.Thread(target=run_event_loop, daemon=True)
        thread.start()

    @classmethod
    async def init_xiaoai(cls):
        GlobalStream.on_output_data = cls.on_output_data
        open_xiaoai_server.register_fn("on_input_data", cls.on_input_data)
        cls.__init_background_event_loop()
        print(ASCII_BANNER)
        await open_xiaoai_server.start_server()
