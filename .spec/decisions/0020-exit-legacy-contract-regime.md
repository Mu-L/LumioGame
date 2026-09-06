# 0020 · 退出旧合同制:删架构镜像与基线闸门,公共语义改指架构仓 Living Architecture

- 日期:2026-09-06
- 状态:生效

## 背景

本仓从建仓起按「合同制」消费公共语义:架构正文有版本号与 Baseline(`LGE-V1.4-2026-08-27`),唯一架构源是生成源仓 `LumioGameEngineArchitecture`,公共契约经 `python3 tools/lumio_contract.py validate` 校验,本仓保存一份只读镜像 `docs/architecture/` 并用 `sha256sum -c .baseline.sha256` 锁住它。

架构仓已按其 ADR-059 转入 Living Architecture,上述四件事全部不复存在:唯一 ABI 真值是 `engine/abi/native-abi.json`,公共语义各落一份 `engine/wire/<name>-v1.json`,Baseline、`tools/lumio_contract.py` 与生成源仓 `LumioGameEngineArchitecture` 都已退役;炸弹人切片的引擎验收真值在架构仓 `.spec/knowledge/features/bomber-slice.md`。

本仓因此留下三层残留(2026-09-06 实测 origin `5bc5afc`):

1. **main 编不过、CI 看不见。** 同级 `LumioGameRuntime` 在 `c2d42b3` 删了 `WorldManager.TryGetSession / BindSelf / UnbindSession / GrantClaim / HasClaim`,`ChatSetMessageSystem.cs` 仍在调用,`dotnet test LumioGame.sln` 报两处 `CS1061`;而 `.github/workflows/repository-policy.yml` 只有一个查 README 字样的作业,没有任何 build / test 步骤,所以 GitHub Actions 四次全绿。
2. **旧合同制残留。** `git grep -l LGE-V1` 命中 18 个已跟踪文件;`docs/architecture/` 364 KB;CI 断言 v1.4 正文、`LGE-V1.4-2026-08-27` 字样与 `sha256sum -c`;README、`.spec/AGENTS.md`、`repository-architecture.md`、`module-scaffolding-design.md`、`modules/server-gameplay/README.md` 通篇是 V1.4 口径;`mvp-placevoxel-content-spec.md` 是 V1.4 时代的挖 / 放方块切片,已被炸弹人切片取代;仓根两份 `.wf-report-*.md` 已跟踪。
3. **卫生。** 6 条已合入的远端分支与一条 `CONFLICTING` 的 PR #12 长期挂着。

来源:架构仓 `.spec/reviews/2026-09-05-engine-repos-progress-assessment.md` §2.6 / §6 的 **D32**(Owner 追认 RM-00008 四张 V1.4 时代 GAS 卡作废)与 **D33**(Owner 裁决 A:R-00482 补验收项并扩到三层)。

## 决策

**全清、不留兼容**,与 NativeCore(D1)、VoxelEngine(D8)、Runtime(D12)、Server(D21)、Client(D25)同一口径。

- **公共语义只从架构仓 `LumioGameEngine` 取**,三个来源:`engine/abi/native-abi.json`、`engine/wire/*.json`、`.spec/knowledge/features/`。本仓**不保存架构镜像、不复述公共契约字段**,只写「在炸弹人里这条契约怎么用」。
- **删除 `docs/architecture/` 整目录**(8 份架构正文、`ADR_INDEX.md`、`5.5Max-ReviewV3`、`.baseline.sha256`),连同基线校验一起退役。
- **删除 `docs/specs/engineering/mvp-placevoxel-content-spec.md`** 与仓根 `.wf-report-R-00354.md` / `.wf-report-live11.md`。
- **CI 从「查字样」改为「真跑构建与测试」**:readme 作业删掉 v1.4 正文、`LGE-V1.4-2026-08-27` 字样与 `sha256sum -c` 六条断言;新增 build-test 作业,checkout 本仓与 `LumioGames/LumioGameRuntime@main`,按 `global.json` 起 .NET 10.0.100,跑 `dotnet build` / `dotnet test LumioGame.sln` 与 `integration/entity-chat` 的三个 node 测试文件。
- **收口门槛改为** `spec-lint` + `spec-lint.test` + `dotnet build LumioGame.sln` + `dotnet test LumioGame.sln` + entity-chat 三个 node 测试文件,删掉 `python3 tools/lumio_contract.py validate` 与「复现 repository-policy.yml」两句。
- **设计与计划的落点改为 `.spec/`**:设计落 `.spec/knowledge/features/`、计划落 `.spec/plans/`;策划案与美术规范仍落 `docs/specs/`(ADR [0002](0002-design-specs-landing-point.md) 不变)。
- **`repository-architecture.md` 按 Living Architecture 重写**,并把与引擎的接缝收敛为三条:地形经引擎体素批量读写、玩法系统经 Tick 相位注册进 `WorldManager.Tick()` 唯一路径、移动与放弹为实体上的 GAS Ability。
- **先合入 R-00408 的 Game 半边修复恢复编译。** 该卡实现方点名的 Game 提交 `d3f6fe0` 至今未推送到任何 origin ref,按 R-00482 验收 1 的兜底口径合入同源分支 `origin/fix/r5-entity-chat-scenarios`(`e243a39`)。
- **不碰 `Bomber/Contracts/**`**:契约与架构第二样板的对齐归 G-0 v2(R-00483),炸弹人规则代码归 G-1 ~ G-7。

## 后果

- 本仓不再有第二份契约真值,也不再有指向已退役仓 `LumioGameEngineArchitecture` 的引用(两处例外见下)。公共语义漂移时不会再出现「镜像说一套、上游说另一套」。
- CI 从此能看见编译红。代价是 build-test 作业依赖 `LumioGames/LumioGameRuntime@main` 可检出(两仓均 public),且本仓 main 会随 Runtime main 的破坏性变更变红——这是想要的信号,不是噪声。
- **两处保留,不清理**:
  - `.spec/decisions/0001 ~ 0019` 的历史 ADR 正文照旧留着旧字样,按「一旦记录不改写」的规矩不动。唯一例外是 [0016](0016-bomber-terrain-out-of-ecs-3d-coords.md) 里指向被删文件的一个 Markdown 链接,为满足 `spec-lint` 的链接可达校验就地去链(措辞与章节号原样保留,决策内容一字未改)。
  - `integration/hello/evidence-run1/manifest.json` 与 `release-manifest.json` 是 2026-08-31 那次真实运行的机器产出证据,里面记录的绝对路径含旧仓名。**改写证据等于伪造记录**,故原样保留;R-00482 验收 4 的字样归零因此不覆盖这两个文件。
- `docs/specs/` 下三处指向被删文件的链接就地去链(`bomber/design.md` 两处、`art-style-pitch.md` 一处),正文措辞与章节号保留。
- ADR [0015](0015-bomber-stage0a-runtime-capability-finding.md) / [0016](0016-bomber-terrain-out-of-ecs-3d-coords.md) / [0019](0019-bomber-terrain-align-voxel-world-contract.md) 里依赖旧架构口径的条款不在本条处置范围,归 G-0 v2(R-00483)按架构第二样板重新裁决。
