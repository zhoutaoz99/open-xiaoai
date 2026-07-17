"use client";

import { DocEditor } from "../components/doc-editor";
import { api } from "../lib/api";

export default function ProfilePage() {
  return (
    <DocEditor
      title="画像"
      description="它对这个家的理解。每句话都会带上它，所以只放「不问也该知道」的事。"
      hint={
        <>
          画像由定时巩固<strong>自动重写</strong>，你也可以直接改——
          巩固的输入包含现画像全文，提示词要求保留没被新证据推翻的内容，
          所以<strong>你手写的话不会被抹掉</strong>。每次改写前都会备份成 <code>*.bak</code>。
          <br />
          <br />
          取舍只有一条标准：<strong>不问也该知道的才进画像</strong>。称呼、家里有谁、长期口味、
          作息、近几天的安排——这些几乎每句话都用得上，常驻能省掉一次检索。
          车牌号、证件号这类问到才需要的明细留在记忆库里，抄进来只会挤掉真正常用的东西。
        </>
      }
      load={api.profile}
      save={api.saveProfile}
    />
  );
}
