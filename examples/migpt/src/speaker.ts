import { jsonEncode } from "@mi-gpt/utils/parse";
import { RustServer } from "./open-xiaoai.js";
import { TTS } from "./tts.js";
import type { ISpeaker } from "@mi-gpt/engine/base";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

export class SpeakerManager implements ISpeaker {
  status: "playing" | "paused" | "idle" = "idle";

  /**
   * 播报队列
   *
   * 注意：引擎播报 AI 回复和外部服务推送提醒可能同时发生，
   * 两股音频流一起写进 aplay 会糊在一起，所以这里把播报串行化。
   */
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * 获取播放状态
   */
  async getPlaying(sync = false) {
    if (sync) {
      // 同步远端最新状态
      const res = await this.runShell("mphelper mute_stat");
      if (res?.stdout.includes("1")) {
        this.status = "playing";
      } else if (res?.stdout.includes("2")) {
        this.status = "paused";
      }
    }
    return this.status;
  }

  /**
   * 播放/暂停
   */
  async setPlaying(playing = true) {
    const res = await this.runShell(
      playing ? "mphelper play" : "mphelper pause"
    );
    return res?.stdout.includes('"code": 0');
  }

  /**
   * 播放文字、音频链接、音频流
   *
   * 注意：多处同时调用时会排队，等前一个播报完毕才会开始下一个
   */
  async play(options: {
    text?: string;
    url?: string;
    bytes?: Uint8Array;
    /**
     * 超时时长（毫秒）
     *
     * 默认 10 分钟
     */
    timeout?: number;
    /**
     * 是否阻塞运行(仅对播放文字、音频链接有效)
     *
     * 如果是则等到音频播放完毕才会返回
     */
    blocking?: boolean;
  }): Promise<boolean> {
    const task = this.queue.then(() => this._play(options));
    // 前一个播报失败不能卡住后面的
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async _play({
    text,
    url,
    bytes,
    timeout = 10 * 60 * 1000,
    blocking = false,
  }: {
    text?: string;
    url?: string;
    bytes?: Uint8Array;
    timeout?: number;
    blocking?: boolean;
  }): Promise<boolean> {
    if (bytes) {
      return RustServer.on_output_data(bytes) as Promise<boolean>;
    }

    if (!url && TTS.enabled) {
      // 使用自定义的语音合成服务播放文字
      const playing = TTS.play(text || "你好");
      if (!blocking) {
        return true;
      }
      if (await playing) {
        return true;
      }
      // 合成失败时，回退到小爱音箱自带的语音合成服务
    }

    if (blocking) {
      const res = await this.runShell(
        url
          ? `miplayer -f '${url}'`
          : `/usr/sbin/tts_play.sh '${text || "你好"}'`,
        { timeout }
      );
      return res?.exit_code === 0;
    }

    const res = await this.runShell(
      url
        ? `ubus call mediaplayer player_play_url '${jsonEncode({
            url: url,
            type: 1,
          })}'`
        : `ubus call mibrain text_to_speech '${jsonEncode({
            text: text || "你好",
            save: 0,
          })}'`,
      { timeout }
    );
    return res?.stdout.includes('"code": 0') ?? false;
  }

  /**
   * 进入连续对话（多轮对话）
   *
   * 音箱会自己放提示音、点灯，并保持约 7 秒的收音窗口（时长由固件决定），
   * 期间用户直接说话即可，无需再说唤醒词。超时没人说话会自动退出，不会一直收音。
   *
   * 注意：需要给音箱刷入开启了多轮对话的补丁固件，详见 packages/client-patch。
   * 原版固件的 mipns 收到这个事件只会报 `unexpected event type: 6`，
   * 但 pnshelper 照样返回 code 0，所以从返回值分辨不出来打没打补丁。
   *
   * 注意：detail 不能为空，否则 pnshelper 直接返回 -1（invalid null pointer）。
   */
  async startMultiRounds() {
    const res = await this.runShell(
      `ubus call pnshelper event_notify '${jsonEncode({
        src: 3,
        event: 4,
        detail: "1",
      })}'`
    );
    return res?.stdout.includes('"code": 0');
  }

  /**
   * （取消）唤醒小爱
   *
   * 注意：唤醒（awake = true）在小爱音箱 Pro（LX06）上无效，两个 src 都不是唤醒——
   * 实测 src:1 是闹钟事件，mipns 收到后直接忽略；能唤醒的只有声学唤醒词。
   * 想让音箱重新收音请改用 startMultiRounds()。
   */
  async wakeUp(
    awake = true,
    options?: {
      /**
       * 静默唤醒
       */
      silent: boolean;
    }
  ) {
    const { silent = true } = options ?? {};
    const command = awake
      ? silent
        ? `ubus call pnshelper event_notify '{"src":1,"event":0}'`
        : `ubus call pnshelper event_notify '{"src":0,"event":0}'`
      : `
        ubus call pnshelper event_notify '{"src":3, "event":7}'
        sleep 0.1
        ubus call pnshelper event_notify '{"src":3, "event":8}'
    `;
    const res = await this.runShell(command);
    return res?.stdout.includes('"code": 0');
  }

  /**
   * 把文字指令交给原来的小爱执行
   */
  async askXiaoAI(
    text: string,
    options?: {
      /**
       * 静默执行
       */
      silent: boolean;
    }
  ) {
    const { silent = false } = options ?? {};
    const res = await this.runShell(
      `ubus call mibrain ai_service '${jsonEncode({
        tts: silent ? undefined : 1,
        nlp: 1,
        nlp_text: text,
      })}'`
    );
    return res?.stdout.includes('"code": 0');
  }

  /**
   * 中断原来小爱的运行
   *
   * 注意：重启需要大约 1-2s 的时间，在此期间无法使用小爱音箱自带的 TTS 服务
   */
  async abortXiaoAI() {
    const res = await this.runShell(
      "/etc/init.d/mico_aivs_lab restart >/dev/null 2>&1"
    );
    return res?.exit_code === 0;
  }

  /**
   * 获取启动分区
   */
  async getBoot() {
    const res = await this.runShell("echo $(fw_env -g boot_part)");
    return res?.stdout.trim();
  }

  /**
   * 设置启动分区
   */
  async setBoot(boot_part: "boot0" | "boot1") {
    const res = await this.runShell(
      `fw_env -s boot_part ${boot_part} >/dev/null 2>&1 && echo $(fw_env -g boot_part)`
    );
    return res?.stdout.includes(boot_part);
  }

  /**
   * 获取设备型号、序列号信息
   */
  async getDevice() {
    const res = await this.runShell("echo $(micocfg_model) $(micocfg_sn)");
    const info = res?.stdout.trim().split(" ");
    return {
      model: info?.[0] ?? "unknown",
      sn: info?.[1] ?? "unknown",
    };
  }

  /**
   * 获取麦克风状态
   */
  async getMic() {
    const res = await this.runShell(
      "[ ! -f /tmp/mipns/mute ] && echo on || echo off"
    );
    let status: "on" | "off" = "off";
    if (res?.stdout.includes("on")) {
      status = "on";
    }
    return status;
  }

  /**
   * 打开/关闭麦克风
   *
   * 注意：event 7 是静音、event 8 是取消静音，别被数字的大小顺序骗了——
   * mipns 收到 event 7 打印的是 `enter notify wakeup mute: 1`（1 = 静音）。
   */
  async setMic(on = true) {
    const res = await this.runShell(
      on
        ? `ubus -t1 -S call pnshelper event_notify '{"src":3, "event":8}' 2>&1`
        : `ubus -t1 -S call pnshelper event_notify '{"src":3, "event":7}' 2>&1`
    );
    return res?.stdout.includes('"code":0');
  }

  /**
   * 删除所有原生提醒和闹钟
   *
   * 小爱云端基于流式识别建提醒/闹钟，在 ASR 定稿（onMessage）前约 0.4-1 秒就已落库，
   * 无法阻止生成，只能在拿到文字后立即删除。
   */
  async cleanNativeAlarms() {
    try {
      const res = await this.runShell(
        `ubus call alarm query '{"type":"alarm"}'`,
        { timeout: 3000 }
      );
      if (!res?.stdout) {
        return;
      }
      console.log("🔍 原生闹钟查询结果:", res.stdout);
      const ids =
        res.stdout.match(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
        ) ?? [];
      for (const id of new Set(ids)) {
        await this.runShell(
          `ubus call alarm delete '{"type":"alarm","id":"${id}"}'`,
          { timeout: 3000 }
        );
        console.log(`🗑️ 已删除原生闹钟/提醒: ${id}`);
      }
    } catch (e) {
      console.warn("⚠️ 清理原生闹钟/提醒失败", e);
    }
  }

  /**
   * 执行脚本
   */
  async runShell(
    script: string,
    options?: {
      /**
       * 超时时间（单位：毫秒）
       */
      timeout?: number;
    }
  ): Promise<CommandResult | undefined> {
    const { timeout = 10 * 1000 } = options ?? {};
    try {
      const res = await RustServer.run_shell(script, timeout);
      if (res) {
        return JSON.parse(res);
      }
    } catch (_) {
      return undefined;
    }
  }
}

export const OpenXiaoAISpeaker = new SpeakerManager();
