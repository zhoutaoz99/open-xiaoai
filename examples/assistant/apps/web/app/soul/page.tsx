"use client";

import { DocEditor } from "../components/doc-editor";
import { api } from "../lib/api";

export default function SoulPage() {
  return (
    <DocEditor
      title="灵魂"
      description="它是谁、什么性格、怎么说话、什么不说。改完存盘，下一句话就换了个人。"
      hint={
        <>
          灵魂只写<strong>「我是谁」</strong>，不用写格式要求——语音播报约束（口语短句、带标点、
          不要 Markdown）是传输层需求，内置在代码里，不随人格变化，也免得你改这里时
          不小心把播报弄坏。
          <br />
          <br />
          <strong>只有你能改它，系统永远不会</strong>。定时巩固改的是画像，不碰这里——
          人格是设定的，理解才是习得的。「清空所有记忆」也不碰这里。
        </>
      }
      load={api.soul}
      save={api.saveSoul}
    />
  );
}
