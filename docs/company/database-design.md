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
| P3-A 最小身份映射 | 评审后的 `identity_mappings` 最小模型 | 受控建立，先于成员投影 |
| P3-B 受控成员投影 | 复用现有 `tenant_members` | 仅按批准的 apply 写入 |
| P4 权限计算 POC | 固定策略数据和策略计算器 | 否 |
| P5 ACL 实现 | 授权算法确认后，再决定是否增加绑定表 | 按结论 |

因此本文中的身份快照表仍是后续实现的候选模型；`identity_mappings` 是 P3-A 需要优先评审的最小持久化边界，但当前仍不执行建表。`permission_bindings` 只有在 P4 通过后才进入数据库决策。

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
created_at
updated_at
```

约束：

- `provider_type + issuer_key` 唯一；
- Secret 只存外部密钥管理系统的引用；
- 禁止通过普通 API 返回 `config_ref` 对应的 Secret。
- `degraded_at` 只表示当前 `healthy -> degraded` 周期；降级期间重复失败不得刷新，恢复 `healthy` 后清空当前值并把起止时间写入健康审计。

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
created_at
updated_at
```

外部管理员只作为属性保存，不能直接映射为本地 Owner。

### 3.4 `identity_user_departments`

```text
provider_id
external_user_id
external_department_id
is_primary
status
first_seen_at
last_seen_at
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

如果业务允许同一 WeKnora 用户绑定多个身份源，不能把 `local_user_id` 设为全局唯一。`provider_id + external_user_id` 是外部身份的稳定来源键；`status` 表示绑定关系是否仍然可信，外部用户 `disabled` 不应立即删除映射，而应由外部状态和统一硬阻断使其不可用。真人会话撤销版本属于本地用户或现有会话机制，不放在 `identity_mappings` 中；API Key 使用独立的凭证撤销机制。

### 3.5.1 本地用户会话撤销边界

这不是当前新增表的承诺，而是 P3-A 必须确认的逻辑归属：

```text
local_user
    -> session_epoch / equivalent_user_session_version
    -> human session and JWT validation
```

Token 使用本地用户标识和签发时的 `session_epoch`；任一绑定身份发生影响登录可信度的停用、删除、解绑或重新绑定时，递增本地用户版本，撤销该用户的全部真人会话。一个本地用户绑定多个身份源时，不允许只撤销单条 mapping 对应的 Token。

API Key 不读取真人 `session_epoch`。独立机器主体使用 Key 自身的 active、过期、撤销和 scope 状态；绑定本地用户的 Key 同时检查本地用户状态，但保留 Key 级撤销。

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
created_at
```

`summary_json` 只保存计数和错误摘要，不保存完整外部响应。

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
valid_from
valid_until
status
created_by
created_at
updated_at
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

`provider_id` 是外部权限主体的命名空间：

- `subject_type = external_department` 时，`provider_id` 必填，`subject_ref` 只在该身份源内解释为外部部门 ID；
- `subject_type = local_user` 时，`provider_id` 为空或不参与主体匹配，主体由本地用户 ID 唯一确定；
- 外部部门绑定的唯一性、查找和审计至少使用 `provider_id + subject_type + subject_ref`，不能只使用 `subject_ref`。

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
10. 失效用户的有效权限必须在授权计算时被硬阻断；
11. P3-B 写入 `tenant_members` 前必须存在唯一且可验证的 active 身份映射，且外部用户当前状态为 `active`；
12. rollback 只能撤销同步拥有的变更，遇到人工修改必须进入冲突；
13. 进入 `revoked` 的删除映射不能被同步批次自动恢复；
14. provider `degraded` 不能覆盖已经确认的 disabled/deleted 状态；
15. 本地用户状态、会话撤销版本或 API Key 撤销状态不可读时，受保护请求必须拒绝。

## 5. 后续实施时的迁移原则

当前不执行迁移。后续迁移按能力边界分开：

- P3-A 通过身份模型、撤销机制和回滚评审后，才允许为最小 `identity_mappings` 模型提交独立迁移；
- P3-B 优先复用现有 `tenant_members`，不因为成员投影自动增加权限表；
- 只有 P5 ACL 实现通过后，才允许评估 `permission_bindings` 迁移。

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
