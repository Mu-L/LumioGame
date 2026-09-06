namespace Lumio.Game.ServerGameplay.Bomber.Contracts.Events;

/// <summary>
/// 玩法格坐标（契约 §1.2）。位置的唯一真值是实体上的 <c>LogicTransform</c>；本类型只承载
/// 由逻辑位置推导出的格子，供事件载荷与遥测使用，不是组件字段、不参与复制或存档。
/// Stage 0 实体恒在游戏 Z = 0 平面，故只有 X / Y 两个分量（v1.3.0 的第三个分量恒为 0，已删）。
/// </summary>
public readonly record struct BomberCell(int X, int Y);

/// <summary>
/// 服务器权威事件，Game 内部 DTO（design.md §7.2/§7.5/§9/§17.1）。经 G-0 的
/// <see cref="Ports.IBomberTelemetrySink"/> 落遥测，网络包络由 C-1 登记。
/// 产生点见契约 §3：DamageApplied / PlayerDied 由 Effect 单结算的 OnFx 记录转译（R-00480），
/// 其余由对应的第 4 相系统产出。
/// </summary>
public readonly record struct BombPlaced(ulong OwnerNetEntityIdRaw, BomberCell Cell, ulong FuseEndTick, ulong Tick);

public readonly record struct BombExploded(ulong ChainId, ulong SourceBombOwnerNetEntityIdRaw, int CellCount, ulong Tick);

/// <summary>
/// 单次扣血事件；同一颗炸弹对同一玩家只出现一次（§7.5 连锁结算口径）。HealthPointsLeft 单位是半心点（ADR 0017），
/// 取自结算后的血量基础账。SourceBombNetEntityIdRaw 是来源炸弹本身的身份（ADR 0018 补齐）——
/// §9.6 的死亡回顾要逐炸弹归因，只有主人分不开同一人在同一 Tick 放的两颗弹。
/// </summary>
public readonly record struct DamageApplied(ulong VictimNetEntityIdRaw, ulong SourceBombNetEntityIdRaw, ulong SourceBombOwnerNetEntityIdRaw, ulong ChainId, int HealthPointsLeft, ulong Tick);

/// <summary>
/// Killer = 让血量基础账跨零的那张 Effect 单的来源（击杀 = 跨零由引擎判，ADR 0021）；
/// 自杀与溺死时 KillerNetEntityIdRaw == VictimNetEntityIdRaw（§9.1）。
/// Cause: 0=爆炸 1=溺水 2=燃烧——§9.6 要求死亡可解释，只靠 Killer == Victim 分不出「自己炸死」和「淹死」。
/// </summary>
public readonly record struct PlayerDied(ulong VictimNetEntityIdRaw, ulong KillerNetEntityIdRaw, ulong ChainId, int Cause, BomberCell Cell, ulong Tick);

public readonly record struct PlayerRespawned(ulong NetEntityIdRaw, BomberCell Cell, ulong Tick);

public readonly record struct HatPileSpawned(BomberCell Cell, int Count, ulong ExpireAtTick, ulong Tick);

public readonly record struct HatPilePicked(ulong PickerNetEntityIdRaw, int Count, ulong Tick);

public readonly record struct HatPileExpired(int Count, ulong Tick);

public readonly record struct PickupTaken(ulong PickerNetEntityIdRaw, int Kind, ulong Tick);

/// <summary>NewHatKingNetEntityIdRaw == 0 表示当前无帽王（§9.3）。</summary>
public readonly record struct HatKingChanged(ulong PreviousHatKingNetEntityIdRaw, ulong NewHatKingNetEntityIdRaw, ulong Tick);

public readonly record struct MatchEnded(ulong Tick);
