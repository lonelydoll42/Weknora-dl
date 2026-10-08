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

上述角色已静态核对 `d9585f7` 的 `internal/types/tenant_member.go`；资源归属守卫见 `internal/router/rbac.go`。这不是接口回归结果。尤其是 `internal/middleware/kb_access.go` 的同 Tenant 分支直接返回 KB 访问许可，不能据此推导部门隔离已经存在。

### 2.2 组织和共享

组织角色和知识库共享是另一条权限轴。基线组织成员是 Tenant，而不是员工：

```text
调用者 Tenant 加入 Organization 的角色
    INTERSECT 知识库共享权限
    INTERSECT 调用者在其当前 Tenant 的角色上限
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

部门关系可以产生资源范围许可和动作授权，但不能独立证明用户已认证、空间成员有效或动作符合 RBAC。

推荐不把部门直接转换为 `tenant`，也不把部门名称写入 `users` 表。

公司一期采用一个主 Tenant：

```text
一个主 Tenant
    +-- WeKnora 现有空间 RBAC
    +-- 企业部门附加策略
    `-- 知识库、组织共享和 API Key 的现有边界
```

部门 grant 是附加能力，不是新的空间角色；部门隔离则是另一个独立的资源范围门槛，会收缩现有同 Tenant 的默认可见范围。仅增加 grant 并集不能实现隔离。启用隔离必须在 P5 明确接入所有读取入口，不宣称基线已提供该能力。

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

权限计算分为四个层次，不能把所有角色压成一个数字后简单取 `min`：

1. 先按主体和访问路径检查硬阻断；
2. 对具体“用户、资源、动作、访问路径”检查资源范围门槛；
3. 在每条路径内部计算 grants 和 ceilings，部门能力限制只裁剪部门 grant；
4. 只合并同一主体通过上述检查的路径结果，不能跨主体叠加。

本节为唯一授权算法定义；架构和路线图只引用其语义，不能维护另一套简化公式。

### 6.1 主体和访问路径

一期至少区分以下四条路径：

| 路径 | 主体 | 主要用途 |
| --- | --- | --- |
| `human_tenant_member` | 本地用户 | 以主 Tenant 成员身份访问空间和空间内资源 |
| `human_organization_share` | 本地用户 | 调用者当前 Tenant 的组织成员关系及 KB 共享访问 |
| `human_shared_agent` | 本地用户 | 通过可访问的共享 Agent 读取其声明范围内的 KB |
| `api_key` | 机器主体 | 以 API Key 声明的 capability 和资源范围访问 |

组织共享和共享 Agent 路径要求调用者在当前 Tenant 有有效成员资格，但不要求其加入资源所属 Tenant。二者不能进入源 Tenant 管理面。共享 Agent 对 KB 只提供 `view/query`，Agent 的 `run` 与底层每个 KB 的 `query` 必须分别判断。API Key 不使用真人会话，也不能与真人权限跨主体合并。

真人请求的可信认证上下文至少包含：

```text
local_user_id + authn_method + authn_provider_id + identity_mapping_id
    + issued_at + active_tenant_id + session_id/revocation_reference
```

认证来源由签名 Token 或服务端会话记录确定，不能接受客户端自行指定 `provider_id`。企业外部登录必须指向一条确定的 active 映射；刷新和切换 Tenant 保留来源且重新验证，不自动切换另一身份源。旧 Token 缺少来源时，只有能从可信会话记录无歧义补齐才可使用，否则要求重新登录。

一期默认不跨身份源合并部门授权：经 `P1` 登录只使用 `P1` 的有效部门关系，即使同一本地用户还有 active 的 `P2` 映射。通过 `P2` 重新登录不恢复 `P1` 的部门或同步成员贡献。本地密码登录仅在显式允许的本地/应急策略下开放，不能借它沿用停用外部身份的授权。

### 6.2 第一步：路径硬门槛

`provider_degraded` 是身份源健康状态，不等同于用户停用。检查的是当前会话明确依赖的身份源，不能把其他 active 身份或保留的 active 标记当作替代证据：

```text
identity_base_pass =
    selected_mapping_active
    AND last_confirmed_status == active
    AND local_user_active

last_verified_fresh =
    last_verified_at IS NOT NULL
    AND 0 <= now - last_verified_at <= max_stale_age

external_session_source_pass =
    identity_base_pass
    AND (
        (provider_healthy AND last_verified_fresh)
        OR (
            provider_degraded
            AND last_verified_fresh
            AND provider_degraded_at IS NOT NULL
            AND token_issued_at < provider_degraded_at <= now
            AND now - provider_degraded_at <= max_stale_age
        )
    )

human_session_usable =
    local_user_active
    AND NOT revocation_pending
    AND session_valid AND token_not_expired AND session_not_revoked
    AND token_issued_at <= now < token_expires_at
    AND (
        (authn_method == external AND external_session_source_pass)
        OR (authn_method == local AND explicit_local_login_policy_pass)
    )
```

`max_stale_age = 24h` 只是预研默认值，生产值须业务和安全共同确认。`last_verified_at` 指选定身份及本次授权依赖的部门事实最近被外部可靠确认的时间；不能用计划审批、apply、Token 签发或 provider 的全局 `last_success_at` 刷新它。多个依赖事实使用最早验证时间。时间缺失、未来时间或 provider disabled/error 均拒绝。已确认的 disabled/deleted 始终拒绝，不因降级恢复。

固定反例：`now = 2026-10-08 16:00 +08:00`，最后确认 active 是 `2026-10-07 15:00 +08:00`，降级开始于 `2026-10-08 14:00 +08:00`。即使未过期 Token 在降级前签发，仍因最后确认状态已满 25 小时而拒绝；不能仅因降级持续 2 小时就放行。

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
    AND caller_tenant_member_active
    AND caller_tenant_organization_membership_active
    AND share_active

human_shared_agent_gate_pass =
    human_session_usable
    AND caller_tenant_member_active
    AND shared_agent_access_active
    AND shared_agent_kb_selection_matches

api_key_gate_pass =
    api_key_active
    AND api_key_not_expired
    AND api_key_not_revoked
    AND api_key_scope_matches
    AND api_key_principal_dependency_pass
```

`gate_pass` 失败只关闭该路径，另一条合法路径可以独立判断；本地账号封禁、会话失效或当前认证来源无效则关闭全部真人路径。某个非选定来源停用不是永久封禁整个本地账号，但会撤销该用户全部旧真人会话。之后可通过另一个有效来源重新认证，不能让旧 Token 自动换来源。

独立 API Key 检查机器主体和 Key 自身状态。绑定本地用户的 Key 额外检查本地账号及明确记录的身份依赖；任一该用户的绑定身份发生停用、删除、解绑或重新绑定时，一期保守规则是撤销该用户全部旧绑定 Key。通过其他身份源重登录不能复活旧 Key；新 Key 必须重新审批并声明有效身份依赖，不继承停用来源授权。基线 Key 表未提供这种用户绑定模型，属于候选扩展，不得误称已实现。

`api_key_principal_dependency_pass` 对独立 Key 检查机器主体有效；对用户绑定 Key 检查本地用户有效、无 `revocation_pending`，以及声明来源的 active mapping、active 身份和事实时效。降级来源还须 Key 在 `degraded_at` 前签发且降级年龄不过限；缺少依赖信息拒绝。不能拿另一来源替代既定依赖，也不通过真人 `session_epoch` 判断 Key。降级期间不签发依赖该来源的新 Key。

真人会话采用本地用户级全量撤销语义。基线已有 `RevokeTokensByUserID` 和 `ValidateToken` 的持久化 Token 撤销检查，应优先复用；只有经并发签发、刷新与撤销验证发现缺口，才评审 `session_epoch` 或等价扩展。身份映射表不承担全量撤销。状态变更与撤销须事务化或先设置持久化 `revocation_pending` 阻断，完成前不允许旧请求或并发签发通过；撤销失败不能标记批次完整成功。API Key 使用独立撤销机制，不读取真人 Token 版本。

`provider_degraded_at` 是当前降级周期开始的时间。降级期间不允许新登录、Token 刷新或重新签发；只有在降级开始前签发、尚未过期且其他本地硬门槛均通过的真人 Token，才可能在 stale 窗口内继续使用。Token 的 `iat` 或等价签发时间必须可验证，不能只检查当前时间距最近成功同步的距离。`healthy -> degraded` 的周期边界由身份源健康状态管理，不能在降级期间因重复失败而刷新。

### 6.3 第二步：部门资源范围门槛

对启用公司隔离的源 Tenant `T0`，必须检查 `resource_scope_pass(subject, resource, action, path)`。Document/Chunk/Wiki、附件和引用先解析到源 KB；不能因为子资源未绑定就跳过门槛。

| 情况 | 范围门槛规则 |
| --- | --- |
| `T0` 内普通成员访问部门资源 | 选定身份源的有效部门绑定匹配具体资源、action 和路径，或存在同样精确的有效用户范围许可 |
| 已有资源未绑定 | 默认拒绝普通成员；创建者身份、contributor 角色和同 Tenant 检查均不构成隐式范围许可 |
| Tenant 内公共资源 | 仅显式标记 `tenant_public` 的资源向有效 `T0` 成员开放指定 `public_actions`，一期默认只有 `view/query`；不是匿名或跨 Tenant 公共 |
| 人工 admin/owner | 在当前 Tenant 为源 `T0` 且人工角色有效时，可豁免部门范围门槛；仍须通过身份、会话、RBAC、资源和平台安全检查并审计，不把“部门负责人”当 admin |
| 受控应急许可 | 必须精确记录用户、资源、action、路径、审批人和有效期；只能豁免其明确批准的范围，不豁免安全阻断 |
| `T0` 成员通过共享/Agent 访问 `T0` 资源 | 仍按上述部门/用户/公共/管理员规则检查；组织共享或 Agent 的 `all` 模式不能扩大内部部门范围 |
| 外部 `T1` 成员访问 `T0` 资源 | 非 T0 内部主体需要源 Tenant 批准的显式导出范围，记录接收 Tenant、组织/Agent、资源、action 和版本；同时满足原共享上限。仅加入组织或看到 Agent 不等于全部源 KB 已获准导出 |
| Workspace 管理及新资源 `create` | 不把不存在的 KB 当成未绑定资源；按管理/创建动作 RBAC 独立判断。普通用户新建 KB 必须在同一事务中按批准模板写入初始范围绑定，否则不开放创建 |
| 未启用公司隔离的其他 Tenant | 保持原有路径范围规则，不把 `T0` 的部门约束全局扩展到所有 Tenant |

部门绑定中的动作集合同时限定范围与候选能力。用户许可必须明确 `scope_grant`，不能把一个 Tenant 级动作 grant 当成所有资源的范围豁免。取消公共标记、绑定过期、部门移动或身份源失效后，范围许可即时失效；不存在“先通过 RBAC 就不用检查范围”的分支。

内部主体由源 Tenant 的企业管理归属/成员贡献识别，不由请求的 `active_tenant_id` 决定。一个 T0 员工同时加入 T1、切换 Tenant 后，访问 T0 仍须内部部门门槛，并额外满足该跨 Tenant 共享的导出范围；不能把自己伪装成外部接收者。归属缺失/不可读拒绝，成员 suspended 不自动把内部主体变成外部访客。管理员范围例外仍要求当前请求在源 Tenant 使用有效人工管理角色。

API Key 使用经批准的显式资源 scope，不继承用户部门范围或管理员豁免。绑定用户的 Key 还受身份依赖约束。Key 即使 `full_access`，也不能绕过本地封禁、撤销或平台安全上限。

### 6.4 第三步：路径内部计算 capability

所有集合均按同一主体、资源、action 和路径解释；先裁剪来源特有的 grant，再施加该路径所有来源共同遵守的安全上限：

```text
bounded_department_grants =
    eligible_department_grants
    INTERSECT department_grant_action_limit

member_grants =
    union(
        tenant_rbac_grants,
        bounded_department_grants,
        user_grants_for_member_path
    )

member_ceilings =
    intersection(
        tenant_rbac_ceiling,
        resource_ownership_ceiling,
        platform_security_ceiling
    )

member_allow(u, r, a) =
    human_tenant_member_gate_pass
    AND resource_scope_pass(u, r, a, human_tenant_member)
    AND a IN (member_grants INTERSECT member_ceilings)
```

```text
share_grants = actions_declared_by_matching_kb_share

share_ceilings =
    intersection(
        caller_tenant_rbac_ceiling,
        organization_tenant_role_ceiling,
        organization_share_ceiling,
        source_resource_ceiling,
        share_path_action_ceiling,
        platform_security_ceiling
    )

share_allow(u, r, a) =
    human_organization_share_gate_pass
    AND resource_scope_pass(u, r, a, human_organization_share)
    AND a IN (share_grants INTERSECT share_ceilings)

agent_allow(u, r, a) =
    human_shared_agent_gate_pass
    AND resource_scope_pass(u, r, a, human_shared_agent)
    AND a IN (
        shared_agent_read_grants INTERSECT {view, query}
        INTERSECT caller_tenant_rbac_ceiling
        INTERSECT organization_tenant_role_ceiling
        INTERSECT agent_share_ceiling
        INTERSECT source_resource_ceiling
        INTERSECT platform_security_ceiling
    )
```

```text
api_key_grants =
    declared_api_key_capabilities

api_key_ceilings =
    intersection(
        api_key_tenant_ceiling,
        api_key_capability_ceiling,
        api_key_resource_scope,
        source_resource_ceiling,
        platform_security_ceiling
    )

api_key_allow(k, r, a) =
    api_key_gate_pass
    AND a IN (api_key_grants INTERSECT api_key_ceilings)
```

其中：

- `Tenant RBAC` 是 Tenant 成员路径的基础上限；
- `tenant_rbac_grants/ceiling` 与共享路径的调用者角色只计算当前认证来源及有效人工贡献，不能直接使用混入其他来源的物化聚合角色；人工 suspended 是独立阻断；
- `resource_ownership_ceiling` 保留现有资源创建者、管理员或其他资源归属守卫；
- `organization_share_ceiling` 只允许共享关系声明的资源和动作；
- `department_grant_action_limit` 只限制部门 grant，不裁剪人工 Tenant admin 的 `manage_members/manage_settings` 等能力；
- `platform_security_ceiling` 是所有来源共同遵守的独立安全上限，不能用部门禁止动作清单代替；
- 组织角色不独立授予未被共享的 KB，用户临时许可也不能增加 share 声明之外的动作；
- `api_key_tenant_ceiling`、`api_key_capability_ceiling` 和 `api_key_resource_scope` 不能被真人角色或部门策略扩大。

### 6.5 第四步：合并同一主体的路径结果

对同一个真人请求，按 action 合并各自通过硬门槛、范围和动作上限的成员、共享及 Agent 路径：

```text
human_allow(u, r, a) =
    human_session_usable
    AND (
        member_allow(u, r, a)
        OR share_allow(u, r, a)
        OR agent_allow(u, r, a)
    )
```

API Key 请求只使用 `api_key_allow`。路径合并只合并已经通过各自范围门槛的结果，不能用组织共享或共享 Agent 绕过部门隔离，也不能把查看权限跨路径升级成管理权限。

硬阻断优先于所有允许规则。第一版不引入复杂的显式 Deny 规则；停用、撤销、过期和安全封禁属于硬阻断，不作为普通 capability 参与计算。

旧版的 `hard_block = ...` 表达容易把“门槛通过”和“发生阻断”混淆，因此统一使用 `*_gate_pass` 表示通过条件，使用“硬阻断”表示条件失败后的结果。

### 6.6 真实入口覆盖要求

| 入口 | P5 必须验证的约束 |
| --- | --- |
| KB/Agent/知识列表、计数、分页、自动补全 | 同一个决策器先过滤可访问资源，再计算可见数量和分页；不能返回未授权名称、ID 或总数 |
| KB 详情、Document/Chunk/Wiki、下载、图片和引用代理 | 从子资源解析源 KB，重新判断 `view`；不能只依赖列表已过滤 |
| hybrid-search、聊天检索、后台 Agent 工具、批量 KB 请求 | 检索前限定可查询 KB，显式请求任一越界 KB 则整次拒绝；动态 `all` 模式只展开到可授权集合，生成引用及缓存命中时再次验证 |
| 组织共享 | 接收方 Tenant 角色、组织 Tenant 成员角色、共享动作与导出范围均有效；内部用户仍受部门门槛限制 |
| 共享 Agent | 显式 `agent_id` 必须匹配该 Agent 的 `all/selected/none` 范围及源 Tenant；不匹配不回退到其他 Agent。未指定 Agent 时也只合并各合法 Agent 可授权的 KB |
| API Key、旧 Token、跨 Tenant 管理入口 | 主体隔离、来源缺失、scope 越界、撤销、superuser 例外均有独立测试；系统管理员不是默认部门豁免 |

公司隔离启用时，Tenant RBAC 和公司范围门槛必须都强制执行；只记录而不拦截的观察模式不得进入隔离生产环境。缓存键包含主体、认证来源、当前/源 Tenant、资源、action 和策略/状态版本；撤销、范围变更和版本变化必须使旧允许结果失效，流式/后台长任务在继续读取前重新验证。没有真实接口回归，不能宣称 P4 计算器结果证明所有入口已安全接入。

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
| 某条外部身份停用 | 该来源同步贡献失效 | 撤销全部旧会话和绑定用户 Key；不永久封禁其他有效来源 |

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
3. 本地封禁和选定身份来源失效优先于所有允许规则；非选定来源不能贡献授权；
4. 部门移动后重新计算，不删除历史审计；
5. 权限映射找不到目标资源时进入冲突，不静默忽略；
6. 同一资源出现多个策略时，记录命中的策略来源；
7. 父部门策略默认不自动继承到子部门，只有显式开启继承的策略才能沿父到子方向传播；
8. 人工紧急授权可以增加 capability 或显式范围许可，但不能突破硬阻断和共同安全上限；
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

POC 不能只列场景名称。以下是固定脱敏夹具，非真实账号；每行测试独立重置，未说明的角色、来源、时间和共享配置不得隐式改变。输出至少包含主体、来源、路径、资源、action、结果、范围命中、grant、ceiling 和拒绝原因。

| 类型 | 固定样本 |
| --- | --- |
| Tenant | 隔离源 Tenant `T0`；接收 Tenant `T1`（不改变公司单主 Tenant 的投影策略） |
| 部门 | `D1 研发`、`D1-1 平台`（`D1` 子部门）、`D2 销售` |
| `P1` 普通用户 | `U1`：`T0 viewer, D1`；`U2`：`T0 contributor, D1+D2`；`U3`：`T0 contributor, D1` 负责人；三者无人工/应急范围许可 |
| 状态用户 | `U4`：`P1 disabled`；`U5`：`P1 deleted` 且 mapping revoked；原 `T0 viewer` 的同步贡献已撤销 |
| 人工管理用户 | `U6`：`T0 admin`，角色人工授予，同时属于普通 `D1`；无系统管理员或 Owner 权限 |
| 接收用户 | `U7`：`T1 viewer`，无 `T0` 成员资格；通过有效 `P2` 认证 |
| 多来源用户 | `U8`：`T0 viewer` 有独立 `P1/P2` 成员贡献；`P1 -> D1`，`P2 -> D2`；每个会话只依赖一条来源 |
| 子部门用户 | `U9`：`T0 viewer, P1, D1-1`；基线策略不继承 |
| 知识库 | 均属于 `T0`；`K1(U3)`、`K2(U1)` 绑定 `P1:D1`；`K3(U2)` 绑定 `P1:D2` 和 `P2:D2`；`K4(U1)` 绑定 `P1:D1`；`K5(U1)` 未绑定；`K6(U1)` 为 `tenant_public(view/query)` |
| 部门动作 | `D1` 的 K1/K2、`D2` 的 K3 允许 `view/query/edit_content`，K4 只允许 `view/query`；`D1-1` 无直接绑定，所有策略禁止第 9 节管理动作 |
| 组织 | `O1` 的 Tenant 成员：`T0 admin`、`T1 viewer`；K4 共享权限 `viewer`；批准向 `T1/O1` 导出 K4 的 `view/query`，无其他 KB 导出许可 |
| 共享 Agent | `A1` 来源 `T0`，向 `T1/O1` 共享 `viewer`，`selected=[K1,K3]`；只批准向 `T1/A1` 导出 K1 的 `view/query`；`all/none` 测试单独变更配置 |
| API Key | `AK1` 为独立机器 Key，`retrieve` 映射为 K1 的 `view/query`，scope 仅 K1，`full_access=false`；`AK2` 是候选用户绑定 Key，绑定 U8/P1，scope 仅 K1 |
| 默认时间 | `now=2026-10-08 16:00 +08:00`；P1/P2 healthy；所依赖事实 `last_verified_at=15:00`；Token/Key `issued_at=13:00`、`expires_at=2026-10-09 12:00 +08:00`，未撤销；`max_stale_age=24h` |
| 降级变体 | `degraded_at=2026-10-08 14:00 +08:00`；只改表中声明的状态/时间；示例 Token TTL 仅用于反例夹具，不代表生产 TTL |

所有本地账号默认 active，无 revocation_pending；未另行指定的用户会话依赖 P1，U7 依赖 P2，U8 按矩阵明确选择来源。父部门默认不继承；测试同时覆盖未继承和显式继承。多部门授权按 action 取并集，但不能突破路径上限。

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
| `U7` | 组织共享 | `K4 / view/query` | 允许；命中 T1/O1、viewer 共享和显式导出范围 |
| `U7` | 组织共享 | `K4 / edit_content` | 拒绝；用户许可不能扩大 viewer 共享上限 |
| `AK1` | API Key | `K1 / view/query` | 允许 |
| `AK1` | API Key | `K3 / view` 或任意写入/管理 action | 拒绝 |
| `U4` | 所有真人路径 | 任意受保护资源 | 其 P1 会话拒绝；无其他有效来源 |
| `U5` | 所有真人路径 | 任意受保护资源 | 其 P1 会话拒绝；保留业务数据和审计 |
| `U1` | Tenant 成员 | K3 唯一用户范围许可已过期，无其他匹配来源 | 拒绝；不是“任一授权过期就全局拒绝” |
| `U9` | Tenant 成员 | `K1 / view` | 默认拒绝；只开启 D1 策略继承的变体允许 |
| `U1` 部门移动到 `D2` 后 | Tenant 成员 | `K1 / view` | 旧部门授权撤销并拒绝；新部门授权另行计算 |
| 任意同步批次 | 组织同步 | 身份源请求失败 | 保持既有状态，不执行批量停用或撤销 |
| `U1` | Tenant 成员 | 降级变体、最后确认 1 小时前、降级前 Token，`K1 / view` | 允许；同时通过两个年龄检查 |
| `U1` | Tenant 成员 | provider degraded，`degraded_at` 后签发或刷新的 Token，`K1 / view` | 拒绝，不得仅凭 stale 时间放行 |
| `U1` | Tenant 成员 | 降级开始 `2026-10-07 15:00`，Token 签发 `2026-10-07 14:00`，事实仍新鲜且 Token 未过期，`K1 / view` | 拒绝；单独证明降级周期年龄检查 |
| `U1` | Tenant 成员 | 最后确认 `2026-10-07 15:00`，降级开始 `2026-10-08 14:00`，未过期旧 Token | 拒绝；25 小时的事实不能被 2 小时降级绕过 |
| `U1` | Tenant 成员 | provider healthy，但最后确认事实 25 小时前，`K1 / view` | 拒绝；provider 全局健康不替代该用户事实时效 |
| 任意用户 | 依赖该状态的路径 | 本地用户、会话撤销或共享/成员状态不可读 | fail-closed，拒绝；不得使用旧缓存允许 |
| `AK1` | API Key | provider degraded，Key 状态和 scope 可读，`K1 / view` | 按 API Key 自身状态判断，不读取真人 Token 版本 |
| `U1` | Tenant 成员 | `K5 / view`，即使是创建者 | 拒绝；未绑定默认拒绝 |
| `U1` | Tenant 成员 | `K6 / view/query`、`K6 / edit_content` | 读取允许，编辑拒绝；公共范围仅开放声明动作 |
| `U7` | 组织共享 | 未向 T1 导出的 `K6 / view` | 拒绝；tenant_public 不是跨 Tenant 公共 |
| `U6` | Tenant 成员 | `K3/K5 / view`、`T0 / manage_members/manage_settings` | 允许；人工 admin 范围豁免和 RBAC 保留，不被部门动作限制裁剪 |
| `U6` | Tenant 成员 | 本地账号封禁后的上述操作 | 全部拒绝；管理员不能豁免硬阻断 |
| `U7` | 共享 Agent A1 | `K1 / view/query` | 允许；Agent selected 和导出许可同时匹配 |
| `U7` | 共享 Agent A1 | `K3 / view`、`K1 / edit_content` | 分别因缺少导出范围、只读上限拒绝 |
| `U7` | 共享 Agent A1 | 显式 agent_id，K4 不在 selected，或 mode=none | 拒绝；不能回退到其他 Agent/组织路径补齐该指定 Agent 范围 |
| `U1` | Agent all 变体 | `K3 / query` | 拒绝；all 不豁免内部部门门槛 |
| `U8` | 任一旧会话 | P1 停用后，原 P1/P2 Token | 均拒绝；全部旧会话撤销 |
| `U8` | P2 新会话 | P1 停用后重新认证，`K3 / view`、`K1 / view` | K3 允许，K1 拒绝；P1 授权不参与 P2 计算 |
| `AK2` | API Key | U8 的 P1 停用后，Key 原来未过期 | 拒绝；用户绑定旧 Key 已独立撤销 |
| `AK2` | API Key | P1 degraded，但事实已 25h，Key 在降级前签发 | 拒绝；Key 自身未撤销也不能绕过依赖来源时效 |
| `U8` | 所有真人/绑定用户 Key 路径 | 本地账号封禁，P2 仍 active | 全部拒绝；独立机器 AK1 不因此失效 |
| `U1` | 列表/详情/检索/引用/下载 | `K3` 及其子资源、旧缓存命中 | 均不得返回 K3 元数据或内容；显式 K1+K3 检索整次拒绝 |
| `U1` | Agent/KB 动态列表 | 省略 agent_id 或 all 模式 | 只返回当前合法范围；过滤后计数、分页，不能泄露隐藏 KB |
| `U1` 的跨 Tenant 变体 | 切换到另一个合法 Tenant 后访问 T0 | 仅有接收 Tenant 的共享许可、没有 T0 部门范围的资源 | 拒绝；改变 active_tenant_id 不改变内部主体归属 |

对显式 Agent 请求，Agent 范围不匹配属于该入口的约束，不能因通用 KB 请求另有共享路径而放行；通用 KB 访问另行按 6.5 合并。时间边界还须覆盖恰好 24h（有效）、超过 24h（拒绝）、缺失/未来时间以及 `issued_at == degraded_at`（拒绝）。

每个读取样本须展开到 6.6 的真实入口清单，P4 仅验证抽象决策，P5 才验证实际接口。同步不能删除人工 `break-glass` 贡献；保留记录不表示它能绕过账号封禁、来源依赖或共同上限。

## 14. POC 通过门槛

P4 只有同时满足以下条件才算通过：

1. 未授权放行数量为 `0`；
2. 已确认应允许的场景误拒绝数量为 `0`；
3. 停用、删除、撤销或过期后的继续放行数量为 `0`；
4. 多部门并集、Tenant RBAC、资源归属、组织共享和 API Key 上限均有对应矩阵结果；
5. 部门负责人非创建者编辑场景必须得到“允许”或“拒绝 + 明确能力缺口”，不能保留 `unknown`；
6. 同一输入连续两次 dry-run 的结果、命中来源和差异计数一致；
7. 所有矩阵项均有明确的 `allow`、`deny` 或 `deny_with_gap` 结果，并通过评审确认；
8. `provider_degraded`、事实年龄与降级年龄、本地撤销状态不可读和 API Key 独立撤销均有结果；
9. 未绑定默认拒绝、公共范围、管理员豁免、共享 Agent、多身份源和用户绑定 Key 均有结果；
10. 每个样本固定 Tenant 角色、组织 Tenant 角色、共享动作、认证来源、签发/确认/降级/到期时间，不能由实现自行补齐。

`deny_with_gap` 不是普通的 `deny`，也不能视为业务能力已经实现。P4 的评审结果分为：

| 结果 | 含义 | 后续允许 |
| --- | --- | --- |
| `fail` | 存在未授权放行、应允许场景误拒绝、状态撤销后继续放行或 `unknown` | 不进入 P5 |
| `security_pass_with_gap` | 安全上限和硬阻断正确，但存在已明确记录的能力缺口 | P5 只能实现无缺口能力；缺口能力不能发布 |
| `pass` | 本次声明范围内没有未决 `deny_with_gap`，所有结果和边界均已确认 | 可进入完整 P5 评审 |

任何 `deny_with_gap` 必须记录缺口描述、影响范围、临时限制、责任人和复核日期，并由业务负责人和权限/安全评审人共同批准。单独的开发人员确认不能视为接受该缺口。委托编辑缺口未解决或未被正式接受前，部门负责人“编辑他人内容”不能作为已交付能力，也不能进入生产发布。

只有 `pass` 才能解锁完整 P5；`security_pass_with_gap` 最多解锁没有缺口的 capability 子集，仍不得实现或发布缺口对应的部门 ACL。在任一结果达到前，不增加 `permission_bindings`，也不修改现有 RBAC 中间件。
