# WeKnora 企业化二开设计包

## 1. 当前状态

本目录只承载企业化接入的设计和预研边界，当前不实现企业微信同步、登录或权限代码。

当前分支：

```text
docs/company-org-permission
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

源码和 Git 基线已接入，已静态核对相关认证、RBAC、组织共享和共享 Agent 入口；构建、基础测试及真实接口回归尚未完成。P0 仍未全部完成，当前不进入企业微信同步、登录或部门 ACL 的功能开发。

开发准入状态：

1. 已获取上述提交的完整源码；
2. 已从 `origin/main` 建立 `develop-company` 和设计分支，共同祖先为上述源码提交；
3. 待验证项目可以构建，基础测试可以运行；
4. 待确认公司一期单主 Tenant 策略的业务适用性；
5. 静态证据见 architecture.md 第 4 节，仍待真实接口验证资源范围与各路径上限；
6. 已统一来源状态、会话撤销和同步版本规则，仍待 POC、业务及安全评审确认。

当前核对结果：

```text
main            -> d9585f75b25cb20c62cceada7fa0069d3a50c97d
origin/main     -> d9585f75b25cb20c62cceada7fa0069d3a50c97d
vendor/main     -> d9585f75b25cb20c62cceada7fa0069d3a50c97d
develop-company -> 从 origin/main 建立的二开集成分支
docs/company-org-permission -> 从 develop-company 建立的设计分支
```

`main` 保留复制自 BlankPeng 的基线，不加入公司定制。此前已建立并推送二开集成分支；本次只更新设计分支，旧设计归档仅在本地保留，不推送到公开 Fork。

本目录仍是待验证的设计稿，不因公式修订自动成为已冻结实施规格。进入 POC 前，需要先确认以下约束：

- Tenant 成员、组织共享、共享 Agent 和 API Key 分路径计算，不能把不同主体的授权条件混成一个集合；
- 部门负责人编辑“明确绑定知识库内容”不能默认突破资源创建者或其他资源归属守卫；
- `active`、`disabled`、`deleted`、同步失败以及会话撤销必须有可执行状态机；
- P3 写入 `tenant_members` 前，必须先有稳定、可审计的最小身份映射；
- 权限 POC 必须有固定样本、完整结果矩阵和明确通过阈值，不能以“场景已列出”代替验证。

已确定的约束：

- 固定样本包含隔离源 T0、接收方 T1、各用户 Tenant 角色、组织 Tenant 角色、共享权限、Agent KB 范围和精确时间；
- 部门隔离使用资源/action/路径范围门槛，未绑定默认拒绝；公共与管理员例外显式定义，部门动作限制仅裁剪部门 grant；
- 真人会话撤销采用本地用户级全量语义，优先复用已有 Token 撤销；不提前锁定新增 `session_epoch`；
- 本地账号封禁、单身份来源失效和全部旧凭证撤销分开；一期不跨来源合并部门授权，用户绑定 Key 独立撤销；
- `revoked` 映射重新绑定时创建新记录，历史记录保留，只有 active 映射要求唯一；
- healthy/degraded 均检查外部事实年龄，降级另检查周期年龄及签发时间；最后 active 25h、降级 2h 必须拒绝；
- apply 校验来源和目标版本、审批 hash 与所有权；rollback 检查版本及变更归属，不能只比较值；
- `deny_with_gap` 只能形成带缺口的安全评审结果，不能解锁缺口能力的生产发布；
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
          |-- docs/company-org-permission
          |-- feat/wecom-org-sync（后续）
          |-- feat/identity-mapping（后续）
          `-- feat/department-acl（后续）

Tencent/WeKnora：规划中的 upstream，仅用于跟踪和分析
```

按已确认的项目约定，临时分支采用 `<类型>/<主题>`，不添加 `codex/` 前缀；类型使用 `docs`、`feat`、`test`、`fix` 或 `sync`，主题使用小写英文和连字符。本地旧归档分支保留历史名称，不作为新分支示范。发布标签采用 `dl-v<主版本>.<次版本>.<修复版本>`，候选版追加 `-rc.<序号>`；本轮不创建标签。

约束：

1. 当前 `vendor` 只用于拉取和比对参考基线，不把公司代码推送到该仓库。
2. `origin` 是日常推送目标，但公开范围必须符合上述脱敏和保密边界。
3. 不直接在 `main` 上开发企业功能，本轮不推送或修改远程 `main`，不使用强制推送。
4. `develop-company` 只接受已经评审的设计和功能分支合并。
5. 每次同步官方版本前，先记录基线提交、数据库迁移变化、认证变化和权限变化。
6. 设计阶段不改变现有 Go、前端和数据库代码。

### 3.1 中文提交和推送规范

每次向 Fork 提交、推送均使用中文说明修改位置、具体内容、验证结果及未验证边界，不能只写“更新文档”或把计划执行当成完成证据：

```text
文档：修正部门隔离与身份同步安全边界

修改位置：docs/company/ 六份设计文档。
修改内容：资源范围门槛、局部部门动作限制、身份来源与撤销、
          外部事实时效、审批计划版本及回滚归属。
验证结果：填写实际完成的检查和计数。
未验证项：填写未运行的构建、真实接口或集成测试。
```

推送前检查差异、敏感信息、工作区和远端分支；只暂存本任务文件，不覆盖他人修改。不强制推送，不改 `main`，推送后重新读取远端 SHA 核验。未经验证的设计不能写成“功能已实现”。

### 3.2 本次审查修订索引

本次基于 `ec2d06b1141ba7408aa2bb2473ebb717c49b61cc`（提交时间 **2026-10-08 14:47:26 +08:00**；作者时间 11:41:10）及“继续审查开发文档”对话的意见。只修正文档，不修改运行时权限。

| 审查问题 | 修订和验收位置 |
| --- | --- |
| P1 单 Tenant 部门隔离 | permission-design.md 6.3 资源范围、6.6 全入口、13 固定矩阵 |
| P2 部门上限误裁人工 admin | permission-design.md 6.4 来源局部裁剪、U6 回归 |
| P1 降级绕过最后确认时效 | permission-design.md 6.2 分支公式、25h/2h 反例 |
| P1 多身份来源停用冲突 | org-sync-design.md 5；permission-design.md 6.1、U8/AK2 样本 |
| P1 旧审批计划及回滚覆盖新状态 | org-sync-design.md 6 版本栅栏、7 CAS/ABA 回滚；database-design.md 元数据 |
| 原对话补充问题 | 双侧归属证明、可见范围与删除证据、组织 Tenant 关系、共享 Agent、强制鉴权和中文提交规范 |

六份文档互相引用同一规则：授权以 permission-design.md 第 6 节为准，状态与版本以 org-sync-design.md 第 5-7 节为准；数据库只描述支撑规则的候选模型，路线图只定义准入与验证。

### 3.3 本轮验证边界

2026-10-08 本轮完成：六份文档的相对链接检查（8 个链接，0 断链）、代码围栏闭合与 27 张表格列数检查、旧公式/分支名检查、差异空白检查和常见凭据模式扫描；并通过 72 项简化内存模型设计演算，覆盖部门范围、人工 admin、共享 Agent、事实时效、多来源凭证、旧计划和 ABA 回滚。

上述演算只检查本文关键规则及反例，临时检查工具不进入功能代码，**不是项目单元测试、正式 P4 POC 或真实接口/集成测试**。未运行 Go/前端构建，当前 PATH 未找到 Go；没有修改运行时授权或数据库。24h、跨来源策略、管理员/公共例外和委托编辑缺口仍须业务及安全评审，不能据此宣布生产隔离已生效。

## 4. 方案摘要

已静态核对用户、空间成员、RBAC、组织 Tenant 成员、KB/Agent 共享和撤销机制；运行时效果仍须验证。以下是拟实施边界，不是已交付功能。

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
- 部门 grant 提供受限候选能力；独立范围门槛实现隔离，来源局部动作限制不裁剪人工管理员，所有路径仍受自己的共同安全上限。
- 同一个请求只在同一主体的适用访问路径之间合并权限，不能把真人权限和 API Key 权限跨主体相加。
- 只有当现有模型无法表达“部门级知识库权限”时，才增加独立的主体和权限绑定层。
- 同步删除采用停用、撤销和审计优先，不能直接物理删除业务数据。
