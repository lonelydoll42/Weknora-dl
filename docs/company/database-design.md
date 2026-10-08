# 企业身份和权限扩展数据设计

## 1. 设计原则

本文只定义候选逻辑模型，不代表最终数据库方案；当前不提交 DDL，不改变现有数据库。

原则：

1. 复用 WeKnora 现有 `users`、`tenant_members`、`organizations`、共享关系和审计日志。
2. 外部同步数据使用独立前缀，避免污染核心用户表。
3. 所有外部 ID 都带身份源维度。
4. 外部快照和本地投影分离。
5. 可重复同步、可审计、可回滚。
6. 不在表中保存企业微信 access token、应用 Secret 或密码明文。

## 1.1 分阶段使用边界

| 阶段 | 数据形态 | 是否建表 |
| --- | --- | --- |
| P1 只读同步 POC | 固定脱敏样本和内存模型 | 否 |
| P2 身份映射 dry-run | 内存中的候选映射和差异报告 | 否 |
| P3-A 最小身份及一致性边界 | 映射、来源验证/版本、计划、变更归属和贡献元数据 | 评审后受控持久化，先于成员投影 |
| P3-B 受控成员投影 | 复用现有 `tenant_members` | 仅按批准的 apply 写入 |
| P4 权限计算 POC | 固定策略数据和策略计算器 | 否 |
| P5 ACL 实现 | 授权算法确认后，再决定是否增加绑定表 | 按结论 |

完整身份快照表仍是候选模型。P3-A 的“最小”不能省略保证时效、并发和撤销所需的持久化元数据；具体复用现有表、增加独立记录还是字段扩展待评审，不强制一次建齐所有候选表。当前不执行建表，`permission_bindings` 和资源范围模型只有在 P4 通过后才进入数据库决策。

## 2. 现有表的使用边界

| 表 | 继续使用 | 企业同步是否直接改写 |
| --- | --- | --- |
| `users` | 本地用户 | 只更新经过批准的非敏感投影字段 |
| `tenant_members` | 空间成员和空间角色 | 仅在 apply 阶段受控写入 |
| `organizations` | 跨空间协作空间 | 不将每个部门自动创建为组织 |
| `organization_tenant_members` | 组织和空间关系 | 由组织共享流程管理 |
| `kb_shares` | 知识库共享 | 不作为部门表替代品 |
| `audit_logs` | 统一审计 | 记录同步和权限变化 |
| `tenant_api_keys` | 机器访问凭证 | 不由普通组织同步自动创建 |

## 3. 候选逻辑模型（当前不建表）

以下模型按阶段进入数据库设计评审：最小 `identity_mappings` 在 P3-A 评审，其他身份快照模型在身份规则稳定后评审，`permission_bindings` 只有在 P4 授权算法通过后评审。

### 3.1 `identity_providers`

```text
id
provider_type
issuer_key
display_name
status
sync_mode
config_ref
last_success_at
degraded_at
max_stale_age
current_snapshot_version
scope_version
config_version
record_version
created_at
updated_at
```

约束：

- `provider_type + issuer_key` 唯一；
- Secret 只存外部密钥管理系统的引用；
- 禁止通过普通 API 返回 `config_ref` 对应的 Secret。
- `degraded_at` 只表示当前 `healthy -> degraded` 周期；降级期间重复失败不得刷新，恢复 `healthy` 后清空当前值并把起止时间写入健康审计。
- `current_snapshot_version` 单调递增；采集代次在请求发出前分配，旧快照、回滚和游标重置不能把版本减回去。

### 3.2 `identity_departments`

```text
id
provider_id
external_id
parent_external_id
name
path
sort_order
status
source_updated_at
last_seen_run_id
snapshot_version
record_version
last_change_id
created_at
updated_at
```

索引和约束：

```text
unique(provider_id, external_id)
index(provider_id, parent_external_id)
index(provider_id, status)
```

### 3.3 `identity_users`

```text
id
provider_id
external_user_id
display_name
username_candidate
email_candidate
status
is_external_admin
source_updated_at
last_seen_run_id
last_verified_at
visibility_state
snapshot_version
security_event_version
record_version
last_change_id
created_at
updated_at
```

外部管理员只作为属性保存，不能直接映射为本地 Owner。`last_verified_at` 是该身份状态的外部可靠确认时间；`visibility_state` 独立于 active/disabled/deleted，不把列表缺失当作 deleted。删除证据和范围版本通过批次/事件记录关联。

### 3.4 `identity_user_departments`

```text
provider_id
external_user_id
external_department_id
is_primary
status
first_seen_at
last_seen_at
last_verified_at
snapshot_version
record_version
last_change_id
```

主键或唯一键：

```text
provider_id + external_user_id + external_department_id
```

### 3.5 `identity_mappings`

```text
id
provider_id
external_user_id
local_user_id
match_method
status
bound_at
last_verified_at
last_sync_run_id
supersedes_mapping_id
rebind_reason
ownership_proof_ref
record_version
last_change_id
revoked_at
created_at
updated_at
```

约束：

```text
unique active(provider_id, external_user_id)
unique active(provider_id, local_user_id)
index(local_user_id, status)
```

这里的唯一性包括两层：同一身份源、同一外部用户最多一个 active 映射；同一身份源、同一本地用户最多一个 active 外部账号。不同身份源仍可以绑定同一本地用户。预研阶段不允许同一身份源下一个本地用户绑定多个 active 外部账号，以避免登录选择、撤销范围和审计主体产生歧义；特殊服务账号应使用独立的本地用户。

这不是所有历史记录都共用一条唯一键。`revoked` 历史记录可以保留；重新绑定时创建新的 mapping 记录，通过 `supersedes_mapping_id` 指向旧记录，并要求重新匹配和人工确认。数据库不具备 filtered/partial unique index 时，要用事务锁和等价的 active 唯一性检查保证同一时刻不能出现两个 active 映射。

不同身份源绑定同一本地用户时，`local_user_id` 不能全局唯一。disabled 保留映射但阻断该来源，不永久封禁另一来源；会话明确绑定认证来源，一期不跨来源合并部门贡献。全量撤销属于本地用户或现有 Token 机制，不放在单条映射中。`ownership_proof_ref` 只记录受控双侧归属证明的类型/摘要引用；邮箱相同不足以自动绑定。

### 3.5.1 会话来源与用户级撤销边界

这不是当前新增表的承诺，而是 P3-A 必须确认的逻辑归属：

```text
local_user
    -> existing AuthToken revocation / optional user session version
    -> human session source and JWT validation

trusted session:
local_user_id
authn_method
authn_provider_id
identity_mapping_id
issued_at
active_tenant_id
revocation_reference
```

优先复用基线 `AuthToken` 记录、`RevokeTokensByUserID` 和 `ValidateToken`。`session_epoch` 是并发验证后才能决定的候选扩展，不是既定新增字段。任一来源停用/删除/解绑/rebind 撤销用户全部旧 access/refresh Token；本地未封禁时允许通过另一有效来源重新登录。状态和撤销事务化，或用持久化 `revocation_pending` 屏障阻断请求及并发签发，清缓存不代替持久化检查。

API Key 不读取真人 `session_epoch`。基线 `tenant_api_keys` 的用户绑定不是现有能力；如后续支持，应通过候选关系记录 `key_id + principal_type + local_user_id/service_principal_id + dependency_provider_id + dependency_mapping_id + record_version`，不能把创建者当成认证依赖。任一用户身份可信度变化撤销该用户全部旧绑定 Key；新 Key 重新审批，明确来源依赖和资源 scope。独立机器 Key 按自身主体和凭证状态判断，不继承真人权限。

### 3.6 `identity_sync_runs`

```text
id
provider_id
mode
cursor
status
started_at
ended_at
created_by
summary_json
snapshot_version
scope_version
config_version
complete
completeness_evidence_ref
created_at
```

`summary_json` 只保存计数和错误摘要。完整性证据包含终止页/游标和可见范围检查，不保存完整敏感响应；批次不完整不能发布为最新可应用快照。

### 3.6.1 同步计划与变更归属（P3-A 前评审）

逻辑记录不强制对应独立表，但必须可持久化、可事务校验：

```text
SyncPlan:
plan_id, provider_id, snapshot_version, scope_version, config_version
policy_version, plan_hash, approval_ref, approval_expires_at, status

SyncChange:
change_id, plan_id, target_type, target_id, field
source_record_version, security_event_version
expected_record_version, expected_field_version
expected_owner, expected_last_change_id, before, after
post_record_version, post_field_version, idempotency_key, status
```

`expected_*` 作为 CAS 条件，成功写入递增版本及 `last_change_id`。rollback 只在变更后版本、变更 ID 和所有权全部一致时执行新版本写入；值相同不能排除 ABA。计划审批绑定 hash，任一来源/目标/策略变化均须重新生成差异和审批。只用数据库更新时间不能替代单调版本。

### 3.6.2 成员与授权贡献（P3-B 前评审）

`tenant_members` 每用户/空间一行，不能据此识别 P1/P2/人工的独立所有权。候选贡献元数据至少包括：

```text
local_user_id, tenant_id, source_type, provider_id, mapping_id
role_or_capabilities, status, owned_fields, record_version, last_change_id
```

外部来源只拥有自己的贡献，停用不覆盖其他有效来源和人工角色。请求只计算选定来源及有效人工贡献；本地人工 suspended/封禁优先。若复用一条物化成员记录，所有参与写入的管理和同步路径都必须同步维护贡献及版本；无法保证时不得开启受控投影。

### 3.7 `identity_sync_errors`

```text
id
run_id
object_type
external_id
error_code
retryable
message_safe
attempt_count
created_at
```

错误消息必须脱敏，不写入 access token、Secret、手机号全量值或外部原始响应。

### 3.8 `permission_bindings`（待 P4 决策）

只有当 P4 权限计算 POC 证明现有空间 RBAC 和组织共享不能表达部门权限，并且授权算法已经评审通过时，才考虑创建该表。

```text
id
subject_type
provider_id
subject_ref
tenant_id
resource_type
resource_id
capabilities
source
access_path
scope_grant
valid_from
valid_until
status
created_by
created_at
updated_at
record_version
last_change_id
```

建议的 `subject_type`：

```text
external_department
local_user
```

建议的 `source`：

```text
directory_sync
manual
break_glass
```

第一版不引入复杂 `deny` 字段；停用、撤销和过期通过 `status` 和统一硬阻断处理。

`capabilities` 是 grant，不等于资源准入。`scope_grant` 显式许可具体资源/action/path 的范围；部门 grant 经 `department_grant_action_limit` 裁剪，人工管理员动作不受该局部限制。人工 grant 与同步 grant 分记录保留所有权，不能合写后让同步删除人工权限。

`provider_id` 是外部权限主体的命名空间：

- `subject_type = external_department` 时，`provider_id` 必填，`subject_ref` 只在该身份源内解释为外部部门 ID；
- `subject_type = local_user` 时，`provider_id` 为空或不参与主体匹配，主体由本地用户 ID 唯一确定；
- 外部部门绑定的唯一性、查找和审计至少使用 `provider_id + subject_type + subject_ref`，不能只使用 `subject_ref`。

### 3.9 资源范围策略（待 P4 决策）

候选逻辑元数据：

```text
tenant_id, resource_type, resource_id
scope_mode = restricted / tenant_public
public_actions
policy_version, record_version, last_change_id

approved export:
source_tenant_id, resource_id, receiver_tenant_id
access_path, organization_id/agent_id, actions
approval_ref, valid_until, status, record_version
```

无范围策略/绑定默认按 restricted 处理，不能通过空值推断公共。`tenant_public` 一期只开放显式 view/query 给源 Tenant 成员；跨 Tenant 必须导出许可。内部企业归属独立于当前 Tenant，员工切换到接收 Tenant 仍须部门范围门槛。人工源 Tenant admin/owner 的例外来自可信角色贡献，不把部门负责人或系统管理员自动视为该例外。子资源解析源 KB，创建资源与初始绑定原子提交，缓存携带主体/来源/路径及状态策略版本。此元数据只支撑 permission-design.md 6.3，不承诺立即建表。

## 4. 一致性约束

1. 同一身份源中的同一外部身份最多只能有一个 active 映射；
2. 同一身份源中的同一本地用户最多只能有一个 active 外部账号；
3. revoked 历史映射可以保留，但不能重新变为 active；重新绑定必须创建新记录并关联旧记录；
4. 组织树不能出现循环父子关系；
5. apply 批次必须可查询、可重放、可终止；
6. 投影失败不能回写为“成功同步”；
7. 同步失败不能触发全量停用；
8. 权限绑定必须指向已存在的空间或资源；
9. 外部部门权限主体必须带 `provider_id` 命名空间；
10. 本地封禁及选定来源失效在授权计算时阻断；另一有效来源必须重新认证，不恢复停用来源贡献；
11. P3-B 写入 `tenant_members` 前必须存在唯一且可验证的 active 身份映射，且外部用户当前状态为 `active`；
12. apply 校验来源/目标版本、审批 hash 和所有权；rollback 校验变更后版本及 last_change_id，遇到人工修改或 ABA 必须冲突；
13. 进入 `revoked` 的删除映射不能被同步批次自动恢复；
14. provider `degraded` 不能覆盖已经确认的 disabled/deleted 状态；
15. 本地用户状态、会话撤销记录/获准版本或 API Key 撤销状态不可读时，依赖该状态的请求必须拒绝；
16. 外部事实验证时间不被本地审批/写入刷新，授权依赖多个事实时采用最早验证时间；
17. 记录版本、来源快照版本只增不减，所有参与写入路径均维护变更归属；
18. 删除/重建对象不能复用旧记录版本或变更归属，避免旧计划命中新对象；
19. 一条来源停用撤销其贡献及全部旧真人/用户绑定 Key，但不删人工或其他有效来源记录；
20. 未绑定资源默认拒绝，部门动作局部上限和全局安全上限分别表达；
21. 来源事实确认失效时建立用户撤销屏障，不能等待普通审批后才阻断；用户绑定 Key 检查声明来源事实时效及签发时间。

## 5. 后续实施时的迁移原则

当前不执行迁移。后续迁移按能力边界分开：

- P3-A 通过身份、来源版本、计划、撤销和回滚评审后，才为最小必要持久化边界提交独立迁移；不能只有映射而缺失并发安全元数据；
- P3-B 优先复用现有 `tenant_members`，不因为成员投影自动增加权限表；
- P4 对对应能力评审通过、进入 P5 后，先评估 `permission_bindings` 与资源范围迁移，再实施和验证；不要求先实现依赖该表的 ACL 才能设计迁移。

所有获批准的迁移都必须：

1. 先写 versioned migration；
2. 同时维护 SQLite、PostgreSQL/ParadeDB 和 MySQL 的支持边界；
3. 每个新增表都有 up/down；
4. 先加表和索引，再接入读路径，最后接入写路径；
5. 不在核心初始化 SQL 中偷偷加入公司专属字段；
6. 对大表迁移评估锁表、回滚和老版本兼容。

## 6. 数据保留和隐私

- 身份映射和审计记录保留时间由公司策略决定；
- 外部用户字段按最小化原则保存；
- 原始同步数据优先在短期诊断缓存中保存，并自动过期；
- Secret 使用环境变量或密钥管理系统；
- 设计文档、测试数据和日志不能包含真实企业凭据。
