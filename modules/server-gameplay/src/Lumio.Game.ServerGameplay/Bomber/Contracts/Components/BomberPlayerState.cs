using Lumio.GameRuntime.Ecs;

namespace Lumio.Game.ServerGameplay.Bomber.Contracts.Components;

/// <summary>
/// 玩家的非属性权威状态（design.md §9/§12）。时间一律 Tick（ulong）。
/// 位置不在这里：唯一真值是实体上的 <c>LogicTransform</c>，所在格由逻辑位置按
/// 契约 §1.2 推导（数学 floor）。血量 / 火力 / 移速 / 手上炸弹数是属性，
/// 归 <c>玩家属性 : AttributeComponent</c> 的基础账与当前账两本账（契约 §1.3），
/// 随 R-00468 落地；本组件只留不参与两本账、不被 Effect 修饰的普通字段。
/// </summary>
[EcsComponent]
public sealed partial class BomberPlayerState : Component
{
    /// <summary>手上的帽子数（design.md §9）。不是属性——不被 Effect 修饰、不进两本账。</summary>
    [Persist] public Sync<int> HatCount = new(Scope.Room, Authority.Server);

    [Persist] public Sync<ulong> RespawnAtTick = new(Scope.Room, Authority.Server);
    [Persist] public Sync<ulong> ProtectedUntilTick = new(Scope.Room, Authority.Server);
}
