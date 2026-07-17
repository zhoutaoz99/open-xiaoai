import type { AppliedOp, ExtractionRecord, MemoryOp } from "../lib/api-types";

const kOpLabel: Record<MemoryOp["op"], string> = {
  add: "新增",
  update: "更新",
  delete: "删除",
  merge: "合并",
};

const kOpTone: Record<MemoryOp["op"], string> = {
  add: "ok",
  update: "accent",
  delete: "danger",
  merge: "warn",
};

const kTypeLabel: Record<string, string> = {
  profile: "身份",
  preference: "偏好",
  fact: "事实",
  event: "事件",
  task: "待办",
  habit: "习惯",
};

/**
 * 一条操作：新增/更新/删除了哪条记忆
 */
export function OpRow({ applied }: { applied: AppliedOp }) {
  const { op } = applied;
  const type = op.op !== "delete" && op.op !== "merge" ? op.type : undefined;
  return (
    <div className="op-row">
      <span className={`tag ${kOpTone[op.op]}`}>{kOpLabel[op.op]}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        {applied.content ?? "（内容已不可考）"}
        {type ? <span className="tag" style={{ marginLeft: 6 }}>{kTypeLabel[type] ?? type}</span> : null}
      </span>
      {applied.id ? <span className="op-id">{applied.id}</span> : null}
    </div>
  );
}

/**
 * 一次抽取的结果
 *
 * 注意："什么都没记"要显示得和"记了"一样清楚。抽取器的首要原则是防污染，
 * 闲聊和百科一律不记，`empty` 是最常见的正确结果——不把它画出来，
 * 用户只会以为是坏了。
 */
export function ExtractionBody({ record }: { record: ExtractionRecord }) {
  if (record.status === "failed") {
    return (
      <>
        <div className="turn-learn-head">
          <span className="tag danger">抽取失败</span>
          <span>整批丢弃，这一轮没有改动记忆库</span>
        </div>
        {record.error ? <div className="op-note">{record.error}</div> : null}
      </>
    );
  }

  if (record.status === "empty" || !record.applied.length) {
    return (
      <div className="turn-learn-head">
        <span className="tag">没记</span>
        <span>闲聊、百科、一次性指令不进记忆库——这是常态</span>
      </div>
    );
  }

  const { stat } = record;
  return (
    <>
      <div className="turn-learn-head">
        <span className="tag accent">记忆已更新</span>
        {stat ? (
          <span>
            新增 {stat.added}、更新 {stat.updated}、删除 {stat.deleted}
            {stat.merged ? `、合并 ${stat.merged}` : ""}
          </span>
        ) : null}
        {record.reason ? <span className="tag">{record.reason}</span> : null}
      </div>
      {record.applied.map((applied, i) => (
        <OpRow key={i} applied={applied} />
      ))}
      {record.turnIds.length > 1 ? (
        <div className="op-note">
          这次抽取一并消化了 {record.turnIds.length} 轮对话（队列积压时会合并成一次调用）
        </div>
      ) : null}
    </>
  );
}
