# WeKnora 企业化二开设计包

## 1. 当前状态

本目录只承载企业化接入的设计和预研边界，当前不实现企业微信同步、登录或权限代码。

当前分支：

```text
codex/docs/company-org-permission
```

参考基线：

```text
仓库: BlankPeng/Weknora-Bp
分支: main
提交: d9585f75b25cb20c62cceada7fa0069d3a50c97d
版本文件: 0.7.2
```

本设计分支基于 `develop-company`，二者均从上述源码基线建立。原来只有设计文档、与源码没有共同祖先的旧分支已保存在本地 `codex/archive/company-design-draft`，最新设计稿从该归档迁入，不合并无关历史。

当前已配置的远程：

```text
origin -> https://github.com/lonelydoll42/Weknora-dl.git
vendor -> https://github.com/BlankPeng/Weknora-Bp.git
```

`origin` 是公开 Fork，不是公司私有仓库。只允许推送经检查可公开的代码、设计和脱敏样例；凭据、真实员工数据、内部地址及未批准公开的材料不得提交。官方 `upstream` 仍是规划中的观察源，尚未配置。

## 1.1 开发准入

源码和 Git 基线已接入，但尚未验证构建、基础测试及现有权限行为。P0 仍未全部完成，当前不进入企业微信同步、登录或部门 ACL 的功能开发。

开发准入状态：

1. 已获取上述提交的完整源码；
2. 已从 `origin/main` 建立 `develop-company` 和设计分支，共同祖先为上述源码提交；
3. 待验证项目可以构建，基础测试可以运行；
4. 待确认公司一期单主 Tenant 策略的业务适用性；
5. 待核对 Tenant RBAC、资源归属、组织共享和 API Key 的实际权限上限；
6. 待确认外部身份状态到本地成员、权限和会话的传播规则。

当前核对结果：

```text
main            -> d9585f75b25cb20c62cceada7fa0069d3a50c97d
origin/main     -> d9585f75b25cb20c62cceada7fa0069d3a50c97d
vendor/main     -> d9585f75b25cb20c62cceada7fa0069d3a50c97d
develop-company -> 从 origin/main 建立的二开集成分支
codex/docs/company-org-permission -> 从 develop-company 建立的设计分支
```

`main` 保留复制自 BlankPeng 的基线，不加入公司定制。本轮仅推送二开集成分支和设计分支；旧设计归档只在本地保留，不推送到公开 Fork。

本目录是企业化架构预研稿，不是实施规格。进入 POC 前，需要先确认以下约束：

- Tenant 成员、组织共享和 API Key 必须分别定义访问路径，不能把不同主体的授权条件混成一个集合；
- 部门负责人编辑“明确绑定知识库内容”不能默认突破资源创建者或其他资源归属守卫；
- `active`、`disabled`、`deleted`、同步失败以及会话撤销必须有可执行状态机；
- P3 写入 `tenant_members` 前，必须先有稳定、可审计的最小身份映射；
- 权限 POC 必须有固定样本、完整结果矩阵和明确通过阈值，不能以“场景已列出”代替验证。

已确定的约束：

- POC 固定样本采用 `K4` 作为组织共享知识库，由 `O1` 共享并验证访问；
- 真人会话撤销采用本地用户级版本；`identity_mappings` 只保留绑定历史，不承担全量 JWT 撤销；
- `revoked` 映射重新绑定时创建新记录，历史记录保留，只有 active 映射要求唯一；
- `provider_degraded` 与用户 `disabled/deleted` 分离；`24h` 只是预研默认值，且只有降级前签发的 Token 能在确认窗口内使用；
- `deny_with_gap` 只能形成带缺口的安全评审结果，不能解锁缺口能力的生产发布。
- 同一身份源下一个本地用户最多一个 active 外部账号；外部部门权限主体必须带 `provider_id` 命名空间。

## 2. 文档索引

| 文档 | 用途 |
| --- | --- |
| [architecture.md](./architecture.md) | 总体边界、分层和关键架构决策 |
| [org-sync-design.md](./org-sync-design.md) | 企业微信及未来 LDAP/OIDC 的组织同步设计 |
| [permission-design.md](./permission-design.md) | 组织、空间、知识库和部门权限的组合模型 |
| [database-design.md](./database-design.md) | 逻辑数据模型、约束和迁移原则 |
| [roadmap.md](./roadmap.md) | 预研阶段、开发阶段和验收门槛 |

## 3. 分支和远程策略

当前分支拓扑：

```text
BlankPeng/Weknora-Bp
        |
        | vendor：当前二开参考基线
        v
lonelydoll42/Weknora-dl（origin，公开 Fork）
  main：保留上游基线
    |
    `-- develop-company：二开集成
          |-- codex/docs/company-org-permission
          |-- codex/feat/wecom-org-sync（后续）
          |-- codex/feat/identity-mapping（后续）
          `-- codex/feat/department-acl（后续）

Tencent/WeKnora：规划中的 upstream，仅用于跟踪和分析
```

临时分支采用 `codex/<类型>/<主题>`，类型使用 `docs`、`feat`、`test`、`fix` 或 `sync`，主题使用小写英文和连字符。二开发布标签采用 `dl-v<主版本>.<次版本>.<修复版本>`，候选版本追加 `-rc.<序号>`；本轮不创建发布标签。

约束：

1. 当前 `vendor` 只用于拉取和比对参考基线，不把公司代码推送到该仓库。
2. `origin` 是日常推送目标，但公开范围必须符合上述脱敏和保密边界。
3. 不直接在 `main` 上开发企业功能，本轮不推送或修改远程 `main`，不使用强制推送。
4. `develop-company` 只接受已经评审的设计和功能分支合并。
5. 每次同步官方版本前，先记录基线提交、数据库迁移变化、认证变化和权限变化。
6. 设计阶段不改变现有 Go、前端和数据库代码。

## 4. 方案摘要

P0 需要核对的现有能力包括用户、租户/空间、空间成员、空间 RBAC、组织、组织成员关系、知识库共享和审计日志。在核对完成前，以下内容都只是设计假设。

企业化接入按下面的链路组织：

```text
企业身份源
    |
    v
Identity Provider Adapter
    |
    v
Identity Normalization and Sync
    |
    v
Local User / Tenant Member Projection
    |
    v
Existing WeKnora RBAC and Resource Sharing
    |
    v
Company Policy Extension
```

方案摘要：

- 企业微信是第一阶段的身份源，不应成为领域模型本身。
- 外部用户 ID、部门 ID 只作为稳定映射键，不能替代 WeKnora 本地用户主键。
- 公司一期使用一个主 Tenant，不按企业部门自动创建多个 Tenant。
- 同步服务负责“谁是谁、属于哪些部门、是否有效”；权限服务负责“能做什么”。
- 现有 `tenant_members`、`organizations`、`kb_shares` 和 RBAC 尽量复用。
- 部门策略只能提供附加 capability，不能突破 Tenant RBAC、资源归属、组织共享和 API Key 的权限上限。
- 同一个请求只在同一主体的适用访问路径之间合并权限，不能把真人权限和 API Key 权限跨主体相加。
- 只有当现有模型无法表达“部门级知识库权限”时，才增加独立的主体和权限绑定层。
- 同步删除采用停用、撤销和审计优先，不能直接物理删除业务数据。
