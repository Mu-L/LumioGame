# 0021 · 炸弹人 Stage 0 契约升 v2.0.0,六个环节改按架构第二样板重写

- 日期:2026-09-06
- 状态:生效

## 背景

G-0(R-00423)于 2026-09-04 冻结的契约 v1.3.0 是照着**当天** Runtime 的三个缺口**反向设计**的——ADR [0015](0015-bomber-stage0a-runtime-capability-finding.md) §0 的核验 ②③⑤ 当时确实不可行:

- 没有系统注册面 → 规则内核做成普通函数,由 Scenario 宿主在 `WorldManager.Tick()` 前后手调;
- 没有体素端口 → 地形走 Game 自有 `ITerrainStore` + `InMemoryChunkStore`(ADR [0016](0016-bomber-terrain-out-of-ecs-3d-coords.md) / [0019](0019-bomber-terrain-align-voxel-world-contract.md));
- 没有 GAS → 位置是 `BomberPlayerState` 自带的 `CellX/Y/Z` + `PosMilliX/Y/Z`,血量 / 火力 / 移速 / 炸弹数是单账 `Sync<int>`,移动 / 放弹是 `MoveIntent` / `PlaceBombIntent` 两个 DTO。

2026-09-05 架构仓把这三个缺口**全部立成了 Runtime 卡**,并同时写下了以后所有战斗类 ECS / GAS 代码的标准:`.spec/knowledge/features/bomber-slice.md` §2(世界模型套用)与 §4(**第二样板**)、ADR-063 第 13 / 14 条、ADR-064、`rules/system.md` 的世界模型红线(静态必须是体素、GAS 只能是实体上的组件、预测一律经 GAS);`movement.md` §9.1 已写好 Game 的位置迁移五步,`tick.md` §4 写好系统注册。

v1.3.0 与第二样板有**六处结构性不同**。按 v1.3.0 继续派 G-1 ~ G-7,等于在游戏仓里造第二条 Tick 路径、第二份地形真值、第二份位置真值;R-00462(RT-1)与 R-00469(E7)一落地,整套推倒重来。

Owner 2026-09-06 裁决 **D33**:先重冻 G-0 v2,再按引擎接缝分两批派(批 A 接缝无关先派,批 B 等引擎卡合入)。依据见架构仓 `.spec/reviews/2026-09-05-engine-repos-progress-assessment.md` §2.6 / §6。

## 决策

契约升 **v2.0.0**,六个环节逐条改按第二样板:

| 环节 | v1.3.0 | v2 | 引擎依赖 |
| --- | --- | --- | --- |
| 位置 | `CellX/Y/Z` + `PosMilliX/Y/Z` 六个 `Sync<int>` | 唯一真值 `LogicTransform`,所在格由逻辑位置**推导** | R-00461(已在 Runtime main) |
| 属性 | 四个单账 `Sync<int>` | `玩家属性 : AttributeComponent` 一处声明,生成**基础账 + 当前账** | R-00468(RT-4) |
| 技能 | `MoveIntent` / `PlaceBombIntent` DTO | `移动技能` / `放弹技能` 两个 `AbilityType`,准入五步,档位「逻辑预测」 | R-00468(RT-4) |
| 系统 | 宿主在 `Tick()` 前后手调 | 五个 `[System(Phase.ProcessorPlan)]` 注册进第 4 相,`Tick()` 唯一路径 | R-00462(RT-1) |
| 伤害 | `DamageApplied` 事件 + 临时命中集合 | 瞬时 `EffectType` 只下单,提交相结算改基础账,击杀 = 跨零由引擎判 | R-00480(RT-5) |
| 地形 | `ITerrainStore` / `InMemoryChunkStore` | 引擎体素:帧初批量读、帧末一批写、pin 常驻 | R-00469(E7) |

**分两段落地,不留替身**:

- **本卡(R-00483)做今天就能编译的部分**:四个组件删位置字段、`BomberPlayerState` 删四个单账属性字段、删 `Bomber/Contracts/Commands/` 整目录、四个 CS EntityType 挂 `[Has(typeof(LogicTransform))]`、重生成 8 个生成文件、探针测试更新。
- **依赖引擎接缝的部分在文档里定形到签名级**(TypeId、输入结构、准入判定、相归属、读写集、顺序),代码随批 B 的 G-1 / G-3 / G-6 在 R-00462 / R-00468 / R-00469 / R-00480 合入后落。**不建占位文件、不加 `#if` 开关、不留「Stage 2 再换实现」的替身。**

**签名一律取自架构仓四张卡的「接口 · Produces」,不自拟**(`.spec/plans/2026-09-05-bomber-engine-runtime-cards.md`)。

**StateHash 的地形那一半改用 Section revision**,取代 v1.3.0 的「全图 box 读结果哈希」:revision 是引擎权威的版本锚点,随批量读结果带回,且 `blockWrite` 的 `expectedSectionRevision` 本就以它为准,两者同源;为做哈希再拉一次全图是白费。

**`scenario.json` 的 `map` 改为「按 Section 的 `BlockId` 数组」**,可直接喂 `blockWrite`,装载时不需要转换层。

**同弹命中记忆改为炸弹实体的普通字段**(不上网、不存档),取代 v1.3.0 的「落服务端临时结构」——系统化之后临时结构没有归属。

**`design.md` §6.1 的转角缓冲落为技能的普通字段**,两端各算各的。

**`方向` 收敛为四向枚举**,取代 `MoveIntent(DirX, DirY)` 的八向自由组合——斜向没有「到路口自动转」的语义,与 §6.1 手感规则冲突。

## 取代关系

以下条款**被本条取代**,三份旧 ADR 只在文末追加一段「被 0021 取代」,正文不改写:

- **ADR 0015**:「规则内核不经 Runtime 编排、由 Scenario 宿主在 `Tick()` 前后按固定顺序调用」一条(编排);「地图网格改为 Game 自有 EcsComponent」在 0016 已被取代,不重复。核验 ①④ 的结论继续有效;②③⑤ 的**结论**(当时不可行)是当日事实、继续成立,但**处置**改由引擎卡提供能力。
- **ADR 0016**:「地形走 Game 自有 `ITerrainStore`」一条。0016 的坐标一律三维、地形不进 ECS、动态物是 Entity 而地形是数据、地图以数据持久化、实体恒 `Z = 0` 继续有效。
- **ADR 0019**:`ITerrainStore` 的**接口形状**条款(三种读请求、四态、每条目 `expectedRevision`、`ApplyBatch` 签名)——抽象本身已删,改为直接消费引擎体素。**坐标映射(游戏 (X,Y,Z) → 引擎 (x=X, z=Y, y=Z+1))、`BlockId` uint32 与不得位运算、九种方块登记官方全局段、材质类只用 Solid 与 Liquid、「阻断爆炸不是引擎的轴」全部保留**;「StateHash 地形那一半由确定性 box 读定义」一条被本条取代(改 Section revision)。

## 后果

- **冻结物 sha256 重算**——这次真的动了 `Bomber/Contracts/**` 的 C# 源码(删字段、删目录、加 `[Has]`),与 v1.3.0「一行 C# 都没碰」不同。
- **`Bomber/Contracts/Commands/` 整目录消失**,`MoveIntent` / `PlaceBombIntent` 不再存在;C-1(R-00431)的 Component Schema 随 v2 变,落点是架构仓 `engine/wire/bomber-*.json`(ADR-059 口径)。
- **G-1 ~ G-7 分批**(D33):批 A(G-2 / G-4 / G-5 / G-7)接缝无关,v2 冻结即可派;批 B(G-1 / G-3 / G-6)等 R-00462 / R-00468 / R-00469 / R-00480 合入。G-4 范围收窄——删「实现 `ITerrainStore`」半边,只做 19×19 灰盒地图生成器。
- **上游新增一条硬约束**:`gen-declarations` 现在 lint「每个非 World 的 `[EntityType]` 必须声明 `[Has(typeof(ObserverComponent))]`」(Runtime `tools/gen-declarations/SourceModel.cs`),四个 CS EntityType 因此一并补上——不补则**生成器直接拒绝生成**,与本次改动无关但必须一起做。Runtime 自己的样例同此写法。
- 四处代码(技能 / 系统 / 属性两本账 / 体素读写)在批 B 落地前**不存在**:仓里不会有 `玩家属性`、`移动技能`、`爆炸系统` 等文件。这是有意的——占位文件会立刻变成第二份真值。
