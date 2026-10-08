# 企业权限体系设计

## 1. 设计目标

权限设计要解决的是：

```text
一个企业用户在某个 WeKnora 资源上，是否可以执行某个动作？
```

判断必须同时考虑：

1. 身份是否有效；
2. 是否有目标空间的成员资格；
3. 在空间中的角色；
4. 是否通过组织共享路径访问；
5. 是否有部门或用户级策略绑定；
6. API Key 是否具备对应能力和资源范围；
7. 是否存在停用、过期或安全阻断。

以上条件不是所有访问请求都必须同时满足。权限计算必须先识别请求主体和访问路径，再检查该路径自己的前置条件；不能因为存在一条授权路径，就替另一条路径补齐缺失的成员资格、会话或 API Key 条件。

## 2. 现有能力必须复用

### 2.1 空间 RBAC

当前基线的空间角色为：

```text
viewer < contributor < admin < owner
```

它解决的是空间内的基础能力和资源归属问题：

- Viewer：读取和查询；
- Contributor：创建资源以及修改自己创建的资源；
- Admin：管理空间成员和空间级配置；
- Owner：空间最高管理权限。

这里的角色含义、资源创建者限制以及各子资源的继承关系，必须在 P0 同步目标源码后逐项核实。本文把它们作为权限上限和风险假设，不把参考仓库的行为直接当成 `BlankPeng/Weknora-Bp` 的已验证事实。

### 2.2 组织和共享

组织角色和知识库共享是另一条权限轴：

```text
组织成员角色 + 知识库共享权限
```

它解决跨空间协作，不应替代空间 RBAC。

### 2.3 API Key

API Key 是机器主体，不能简单套用真人成员角色。它还需要能力集合和知识库范围，例如检索、写入、管理知识库等。

### 2.4 审计

成员变更、同步变更、权限授予、权限撤销和拒绝请求都要能关联到：

```text
actor + source + target + action + outcome + timestamp
```

## 3. 企业部门的定位

企业部门不是新的登录主体，而是一个“权限策略主体”：

```text
外部部门 -> 策略绑定 -> WeKnora 资源
```

用户的有效权限由其所属部门和个人临时绑定共同产生。

推荐不把部门直接转换为 `tenant`，也不把部门名称写入 `users` 表。

公司一期采用一个主 Tenant：

```text
一个主 Tenant
    +-- WeKnora 现有空间 RBAC
    +-- 企业部门附加策略
    `-- 知识库、组织共享和 API Key 的现有边界
```

部门授权是附加能力，不是新的空间角色，也不能借此突破主 Tenant 的安全边界。

## 4. 映射方案比较

| 方案 | 优点 | 风险 | 结论 |
| --- | --- | --- | --- |
| 部门 = WeKnora Tenant | 复用现有空间角色 | 空间爆炸、用户跨部门复杂、资源归属混乱 | 不推荐 |
| 部门 = Organization | 可复用组织共享 | 组织语义是协作空间，不是细粒度部门 ACL | 只适合粗粒度共享 |
| 部门 = 外部策略主体 | 语义清晰、可扩展 | 需要策略绑定和统一鉴权入口 | 推荐 |
| 只同步用户，不同步部门权限 | 实现简单 | 无法满足部门级隔离 | 仅适合第一阶段 |

## 5. 推荐分阶段模型

### 阶段 A：粗粒度准入

```text
企业用户 -> local user -> tenant_members
```

只解决用户是否能进入某个空间，角色使用现有 `viewer/contributor/admin/owner`。

### 阶段 B：组织级共享

```text
企业用户/业务空间 -> organization -> kb_shares
```

适合“整个业务团队可以查看某知识库”的场景。

### 阶段 C：部门级资源权限

引入公司扩展的策略绑定：

```text
department/user
       |
       v
policy binding
       |
       v
resource + capability
```

这一阶段才决定是否需要增加权限主体、资源绑定和统一授权解析器。

## 6. 有效权限计算

权限计算分为三个层次，不能把所有角色压成一个数字后简单取 `min`：

1. 先按主体和访问路径检查硬阻断；
2. 在每条路径内部计算 grants 和 ceilings；
3. 只合并同一主体可用的路径结果，不能跨主体叠加。

### 6.1 主体和访问路径

一期至少区分以下三条路径：

| 路径 | 主体 | 主要用途 |
| --- | --- | --- |
| `human_tenant_member` | 本地用户 | 以主 Tenant 成员身份访问空间和空间内资源 |
| `human_organization_share` | 本地用户 | 通过组织成员关系和知识库共享访问资源 |
| `api_key` | 机器主体 | 以 API Key 声明的 capability 和资源范围访问 |

组织共享路径不自动要求目标 Tenant 的成员资格，但它只能访问被共享的资源，不能借此进入目标 Tenant 的成员管理、空间设置等管理面。API Key 不使用真人会话，也不能与某个真人请求的 Tenant 成员权限跨主体合并。

### 6.2 第一步：路径硬门槛

`provider_degraded` 是身份源健康状态，不等同于某个用户已经被停用。为了避免一次外部同步失败导致全员拒绝，外部身份可用条件定义为：

```text
external_identity_usable =
    externally_confirmed_active
    OR (
        provider_degraded
        AND last_confirmed_active
        AND last_verified_within_max_stale_age
    )

human_session_usable =
    external_identity_usable
    AND (
        provider_healthy
        OR (
            provider_degraded
            AND token_issued_at < provider_degraded_at
            AND degraded_age <= max_stale_age
        )
    )
```

`max_stale_age = 24h` 目前只是预研默认值，不是最终生产决策。进入 POC 前必须由业务和安全评审确认具体值；未确认前不能把它作为生产配置冻结，也不能无限期沿用最后一次成功状态。已确认的 `disabled` 或 `deleted` 不因 `provider_degraded` 恢复为可用。

```text
human_tenant_member_gate_pass =
    human_session_usable
    AND local_user_active
    AND tenant_member_active
    AND session_valid
    AND token_not_expired
    AND session_not_revoked

human_organization_share_gate_pass =
    human_session_usable
    AND local_user_active
    AND session_valid
    AND token_not_expired
    AND session_not_revoked
    AND organization_membership_active
    AND share_active

api_key_gate_pass =
    api_key_active
    AND api_key_not_expired
    AND api_key_not_revoked
    AND api_key_scope_matches
```

`gate_pass` 表示路径前置条件全部满足；任一条件不满足就是硬阻断，直接拒绝，不再进入 capability 计算。外部用户 `disabled`、`deleted`、本地用户撤销或会话撤销时，不能通过组织共享路径绕过硬阻断。

如果 API Key 绑定了本地用户或服务主体，还必须检查该主体是否有效；如果 API Key 是独立机器主体，则检查机器主体自身的状态。不能用“没有真人会话”作为跳过撤销检查的理由。

真人 Token 使用本地用户级 `session_epoch` 或等价的会话撤销版本。Token 携带本地用户标识和签发时的版本，请求时与当前本地用户版本比较；身份映射表不承担真人会话的全量撤销职责。API Key 使用自己的 `revoked_at`、凭证版本或等价机制；如果 API Key 绑定本地用户，则同时检查 API Key 状态和本地用户状态，但不读取真人 Token 的 `session_epoch`。

`provider_degraded_at` 是当前降级周期开始的时间。降级期间不允许新登录、Token 刷新或重新签发；只有在降级开始前签发、尚未过期且其他本地硬门槛均通过的真人 Token，才可能在 stale 窗口内继续使用。Token 的 `iat` 或等价签发时间必须可验证，不能只检查当前时间距最近成功同步的距离。`healthy -> degraded` 的周期边界由身份源健康状态管理，不能在降级期间因重复失败而刷新。

### 6.3 第二步：路径内部计算 capability

每条路径单独计算 grants 和 ceilings。所有集合均按具体 action 解释：

```text
member_grants =
    union(
        tenant_rbac_grants,
        department_grants,
        user_grants_for_member_path
    )

member_ceilings =
    intersection(
        tenant_rbac_ceiling,
        resource_ownership_ceiling,
        department_policy_ceiling
    )

member_capability =
    member_grants
    intersect
    member_ceilings
```

```text
share_grants =
    union(
        organization_membership_grants,
        organization_share_grants,
        user_grants_for_share_path
    )

share_ceilings =
    intersection(
        organization_share_ceiling,
        source_resource_ceiling,
        share_path_action_ceiling
    )

share_capability =
    share_grants
    intersect
    share_ceilings
```

```text
api_key_grants =
    declared_api_key_capabilities

api_key_ceilings =
    intersection(
        api_key_tenant_ceiling,
        api_key_capability_ceiling,
        api_key_resource_scope,
        source_resource_ceiling
    )

api_key_capability =
    api_key_grants
    intersect
    api_key_ceilings
```

其中：

- `Tenant RBAC` 是 Tenant 成员路径的基础上限；
- `resource_ownership_ceiling` 保留现有资源创建者、管理员或其他资源归属守卫；
- `organization_share_ceiling` 只允许共享关系声明的资源和动作；
- `department_policy_ceiling` 限制部门策略能够提供的动作集合；
- `api_key_tenant_ceiling`、`api_key_capability_ceiling` 和 `api_key_resource_scope` 不能被真人角色或部门策略扩大。

### 6.4 第三步：合并同一主体的路径结果

对同一个真人请求，如果 Tenant 成员路径和组织共享路径都通过各自的硬门槛，则按 action 合并：

```text
human_effective_capability =
    member_capability
    union
    share_capability
```

API Key 请求只使用 `api_key_capability`，不能与 `human_effective_capability` 做并集。路径合并只能合并相同主体、相同资源、相同 action 的结果，不能用一条路径的成员资格替另一条路径补齐前置条件，也不能把查看权限跨路径升级成管理权限。

硬阻断优先于所有允许规则。第一版不引入复杂的显式 Deny 规则；停用、撤销、过期和安全封禁属于硬阻断，不作为普通 capability 参与计算。

旧版的 `hard_block = ...` 表达容易把“门槛通过”和“发生阻断”混淆，因此统一使用 `*_gate_pass` 表示通过条件，使用“硬阻断”表示条件失败后的结果。

## 7. 动作集合

权限不要直接绑定 HTTP 路由，应先定义稳定动作：

| 资源 | 动作 |
| --- | --- |
| Workspace | `view`、`manage_members`、`manage_settings` |
| KnowledgeBase | `view`、`query`、`create`、`edit_metadata`、`delete`、`share` |
| Knowledge content（Document/Chunk/Wiki） | `view`、`ingest`、`edit_content`、`delete` |
| Agent | `view`、`run`、`edit`、`share` |
| Integration | `view`、`manage` |
| API Key | `view`、`create`、`revoke` |

路由层只负责把请求转换为动作和资源，权限决策集中在授权服务或策略解析器。`edit_metadata` 和 `edit_content` 必须分开，否则部门负责人编辑内容的业务目标会被误读为可以修改知识库设置。

## 8. 推荐默认映射

以下只是预研默认值，不是最终生产策略：

| 企业身份状态 | 本地空间默认角色 | 说明 |
| --- | --- | --- |
| 有效普通员工 | `viewer` | 最小权限 |
| 被批准参与知识维护的员工 | `contributor` | 仍受资源归属限制 |
| 企业权限管理员且在白名单中 | `admin` | 不自动授予 |
| WeKnora 平台运维人员 | `owner` 或系统管理员 | 只允许人工或受控流程 |
| 外部用户停用 | 无有效成员资格 | 撤销会话和临时授权 |

部门权限映射应采用配置而不是硬编码：

```text
身份源 + 部门路径/外部部门 ID
    -> 目标空间
    -> 资源范围
    -> capability 集合
    -> 生效时间和过期时间
```

## 9. 部门策略禁止直接授予的能力

部门策略不得直接授予以下能力：

- `owner`；
- 系统管理员；
- `manage_members`；
- `manage_settings`；
- `edit_metadata`；
- `delete` 知识库；
- `share` 知识库。

部门负责人也不能通过部门策略自动获得上述能力；`create` 是否允许必须单独配置和验证，不能从“负责人”身份推导。需要这些能力时，应使用现有 Tenant RBAC，并由受控的人工或平台流程授予。

## 10. 多部门和冲突规则

推荐规则：

1. 多个部门的允许权限取并集；
2. 用户临时授权不能突破平台安全上限；
3. 停用状态优先于所有允许规则；
4. 部门移动后重新计算，不删除历史审计；
5. 权限映射找不到目标资源时进入冲突，不静默忽略；
6. 同一资源出现多个策略时，记录命中的策略来源；
7. 父部门策略默认不自动继承到子部门，只有显式开启继承的策略才能沿父到子方向传播；
8. 人工紧急授权可以在有效期内增加 capability，但不能突破硬阻断和 ceilings；
9. 同步只拥有它创建的成员、部门关系和同步授权字段，不得覆盖人工角色、人工授权或 `break-glass` 权限；
10. 没有显式 Deny 语义时，人工“拒绝”不能被假定为普通 grant 的反向规则，必须另行评审。

## 11. 部门负责人语义

在权限 POC 中，部门负责人暂不直接映射为 `Contributor`。一期建议把其语义限定为：

- 可以查看和查询本部门资源；
- 业务目标是可以编辑明确绑定的知识库内容及其允许编辑的子资源；
- 不能删除知识库；
- 不能共享知识库；
- 不能管理空间成员；
- 不能修改空间设置。

这里的“编辑内容”只对应 `edit_content`，不包含 `edit_metadata`、`delete` 或 `share`。同时，部门绑定不是资源归属的自动例外：最终是否允许编辑非本人创建的内容，仍必须经过现有资源创建者或管理员守卫。

因此 POC 必须专门验证两类情况：

1. 部门负责人编辑自己创建的、已明确绑定的内容；
2. 部门负责人编辑他人创建的、已明确绑定的内容。

第二类如果在目标基线中只能被现有资源归属守卫拒绝，应记录为“委托编辑能力缺口”，不能为了让场景通过而修改核心 RBAC。只有在另行批准委托编辑语义、作用范围和回滚规则后，才可以把它变成新的可实现能力。

## 12. 人工覆盖和紧急权限

企业目录同步不能阻止紧急运维，因此需要受控的本地覆盖：

- 必须记录授权人；
- 必须设置过期时间；
- 必须记录原因；
- 不能通过同步永久刷新；
- 到期自动撤销；
- 所有覆盖必须进入审计。

“临时管理员”不应通过修改外部部门名称实现。

## 13. 权限 POC 固定样本和结果矩阵

POC 不能只列场景名称，必须使用固定脱敏样本，输出“主体 × 访问路径 × 资源 × action × 预期结果 × 命中来源”。建议最小样本如下：

| 类型 | 固定样本 |
| --- | --- |
| Tenant | 一个主 Tenant `T0` |
| 部门 | `D1 研发`、`D1-1 平台`（`D1` 子部门）、`D2 销售` |
| 真人用户 | `U1` 单部门（`D1`）、`U2` 多部门（`D1 + D2`）、`U3` 部门负责人、`U4` disabled、`U5` deleted |
| 知识库 | `K1` 由 `U3` 创建并绑定 `D1`、`K2` 由 `U1` 创建并绑定 `D1`、`K3` 由 `U2` 创建并绑定 `D2`、`K4` 由 `U1` 创建并由组织 `O1` 共享 |
| 组织 | `O1` 共享 `K4`，用于验证组织共享访问 |
| API Key | `AK1` 只声明 `K1` 的 `view/query`，不声明写入和管理能力 |

父部门策略默认不继承到子部门；测试应同时覆盖“未显式继承”和“显式继承”两种结果。多部门授权按具体 action 取并集，但不能突破任何 ceiling。

| 主体 | 访问路径 | 资源 / action | 预期结果 |
| --- | --- | --- | --- |
| `U1` | Tenant 成员 | `K1 / view` | 按绑定策略允许 |
| `U1` | Tenant 成员 | `K3 / view` | 拒绝，不因主 Tenant 成员资格自动获得 |
| `U2` | Tenant 成员 | `K1 / view`、`K3 / view` | 两项分别允许，证明多部门取并集 |
| `U2` | Tenant 成员 | `K1 / edit_content`（非本人创建） | 受资源归属上限限制，不能仅凭部门并集放行 |
| `U3` | Tenant 成员 | 已绑定 `K1 / view/query` | 允许 |
| `U3` | Tenant 成员 | 自己创建且已绑定 `K1 / edit_content` | 允许，前提是基线资源守卫允许 |
| `U3` | Tenant 成员 | 他人创建且已绑定 `K2 / edit_content` | 若无安全委托编辑能力则“拒绝 + 能力缺口”；不能记为未知 |
| `U3` | Tenant 成员 | `K1 / delete`、`K1 / share` | 拒绝 |
| `U3` | Tenant 成员 | `T0 / manage_members`、`T0 / manage_settings` | 拒绝 |
| 非 `T0` 成员的有效用户 | 组织共享 | `K4 / view/query` | 仅在 `O1` 成员和共享关系有效时允许 |
| 同一共享用户 | 组织共享 | `K4 / edit_content` | 拒绝，组织共享不能自动升级写权限 |
| `AK1` | API Key | `K1 / view/query` | 允许 |
| `AK1` | API Key | `K3 / view` 或任意写入/管理 action | 拒绝 |
| `U4` | 任一路径 | 任意受保护资源 | 拒绝；停用必须硬阻断 |
| `U5` | 任一路径 | 任意受保护资源 | 拒绝；删除后保留业务数据和审计 |
| 任意用户 | 任一路径 | 已过期临时授权 | 拒绝 |
| 子部门用户 | Tenant 成员 | 只绑定父部门的资源 | 默认拒绝；显式继承后才重新计算 |
| `U1` 部门移动到 `D2` 后 | Tenant 成员 | `K1 / view` | 旧部门授权撤销并拒绝；新部门授权另行计算 |
| 任意同步批次 | 组织同步 | 身份源请求失败 | 保持既有状态，不执行批量停用或撤销 |
| `U1` | Tenant 成员 | provider degraded，`degraded_at` 前签发 Token，`K1 / view` | 在已批准的 `max_stale_age` 内允许 |
| `U1` | Tenant 成员 | provider degraded，`degraded_at` 后签发或刷新的 Token，`K1 / view` | 拒绝，不得仅凭 stale 时间放行 |
| `U1` | Tenant 成员 | provider degraded 超过 `max_stale_age`，旧 Token，`K1 / view` | 拒绝 |
| 任意用户 | 任一路径 | 本地用户状态、`session_epoch` 或共享/成员撤销状态不可读 | fail-closed，拒绝 |
| `AK1` | API Key | provider degraded，Key 状态和 scope 可读，`K1 / view` | 按 API Key 自身状态判断，不读取真人 Token 版本 |

人工授权与同步授权的冲突规则必须在结果中体现：同步不能删除人工 `break-glass` 授权；人工授权也不能突破硬阻断、资源归属和 API Key 等上限。每一条结果都必须能追溯到具体 grant、ceiling、状态和策略来源。

## 14. POC 通过门槛

P4 只有同时满足以下条件才算通过：

1. 未授权放行数量为 `0`；
2. 已确认应允许的场景误拒绝数量为 `0`；
3. 停用、删除、撤销或过期后的继续放行数量为 `0`；
4. 多部门并集、Tenant RBAC、资源归属、组织共享和 API Key 上限均有对应矩阵结果；
5. 部门负责人非创建者编辑场景必须得到“允许”或“拒绝 + 明确能力缺口”，不能保留 `unknown`；
6. 同一输入连续两次 dry-run 的结果、命中来源和差异计数一致；
7. 所有矩阵项均有明确的 `allow`、`deny` 或 `deny_with_gap` 结果，并通过评审确认；
8. `provider_degraded`、`max_stale_age`、本地撤销状态不可读和 API Key 独立撤销均有结果。

`deny_with_gap` 不是普通的 `deny`，也不能视为业务能力已经实现。P4 的评审结果分为：

| 结果 | 含义 | 后续允许 |
| --- | --- | --- |
| `fail` | 存在未授权放行、应允许场景误拒绝、状态撤销后继续放行或 `unknown` | 不进入 P5 |
| `security_pass_with_gap` | 安全上限和硬阻断正确，但存在已明确记录的能力缺口 | P5 只能实现无缺口能力；缺口能力不能发布 |
| `pass` | 本次声明范围内没有未决 `deny_with_gap`，所有结果和边界均已确认 | 可进入完整 P5 评审 |

任何 `deny_with_gap` 必须记录缺口描述、影响范围、临时限制、责任人和复核日期，并由业务负责人和权限/安全评审人共同批准。单独的开发人员确认不能视为接受该缺口。委托编辑缺口未解决或未被正式接受前，部门负责人“编辑他人内容”不能作为已交付能力，也不能进入生产发布。

只有 `pass` 才能解锁完整 P5；`security_pass_with_gap` 最多解锁没有缺口的 capability 子集，仍不得实现或发布缺口对应的部门 ACL。在任一结果达到前，不增加 `permission_bindings`，也不修改现有 RBAC 中间件。
