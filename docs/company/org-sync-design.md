# 企业组织同步设计

## 1. 目标

第一阶段只讨论组织身份同步，不实现代码。公司一期以一个主 Tenant 为投影目标，不按部门自动创建多个 Tenant：

- 同步企业微信部门树；
- 同步企业微信用户；
- 记录用户和部门的多对多关系；
- 处理用户启用、停用、离职和部门变更；
- 为未来 LDAP/OIDC 保留相同的身份抽象；
- 生成可审计、可回滚的差异报告。

## 2. 领域对象

```text
IdentityProvider
    |
    +-- ExternalDepartment
    |
    +-- ExternalUser
            |
            +-- ExternalUserDepartment
            |
            `-- IdentityMapping -> WeKnora User
```

### 2.1 IdentityProvider

代表一个外部身份源实例，而不是某个 SDK。

建议字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 本地身份源 ID |
| `provider_type` | `wecom`、`ldap`、`oidc` |
| `issuer_key` | 企业标识、OIDC issuer 或 LDAP server 标识 |
| `display_name` | 管理后台显示名称 |
| `status` | `healthy`、`degraded`、`disabled`、`error` |
| `sync_mode` | `inspect`、`dry-run`、`apply` |
| `last_success_at` | 最近成功同步时间 |
| `degraded_at` | 当前 `healthy -> degraded` 周期的开始时间；`healthy` 时为空，历史值进入同步健康审计 |
| `max_stale_age` | 允许沿用最后确认状态的最大时长，预研默认 `24h` |
| `config_ref` | 密钥配置引用，不直接保存明文密钥 |

### 2.2 ExternalDepartment

保存部门的规范化快照。以下对象是后续实现时的候选逻辑模型，不代表当前立即建表：

| 字段 | 说明 |
| --- | --- |
| `provider_id` | 身份源 |
| `external_id` | 外部部门 ID |
| `parent_external_id` | 外部父部门 ID |
| `name` | 部门名称 |
| `path` | 规范化部门路径 |
| `sort_order` | 外部排序 |
| `status` | `active`、`disabled`、`deleted` |
| `source_updated_at` | 外部更新时间 |
| `last_seen_run_id` | 最近一次发现它的同步批次 |

唯一键建议为：

```text
(provider_id, external_id)
```

不能使用部门名称作为唯一键。

### 2.3 ExternalUser

保存外部用户的最小必要快照。P1 和 P2 先使用固定脱敏样本或内存模型验证，不要求立即持久化：

| 字段 | 说明 |
| --- | --- |
| `provider_id` | 身份源 |
| `external_user_id` | 外部用户 ID |
| `username` | 本地显示名或登录名候选 |
| `email` | 邮箱候选 |
| `mobile_hash` | 如必须匹配手机号，优先保存不可逆摘要 |
| `status` | `active`、`disabled`、`deleted` |
| `is_admin` | 外部管理员标志，仅作属性，不直接等于本地 Owner |
| `source_updated_at` | 外部更新时间 |
| `last_seen_run_id` | 最近发现批次 |

唯一键建议为：

```text
(provider_id, external_user_id)
```

不要保存完整外部原始响应作为业务字段。确需排障时，只保存经过脱敏和过期控制的诊断摘要。

### 2.4 IdentityMapping

把外部身份绑定到本地用户：

| 字段 | 说明 |
| --- | --- |
| `provider_id` | 身份源 |
| `external_user_id` | 外部用户 ID |
| `local_user_id` | WeKnora `users.id` |
| `match_method` | `explicit`、`email_verified`、`manual` |
| `status` | `active`、`conflict`、`revoked` |
| `bound_at` | 首次绑定时间 |
| `last_verified_at` | 最近确认时间 |
| `supersedes_mapping_id` | 重新绑定时指向旧映射 |
| `rebind_reason` | 重新绑定原因和审批摘要 |

安全规则：

1. 自动匹配只能使用明确的可验证规则。
2. 邮箱匹配必须经过唯一性和域名策略检查。
3. 姓名相同不能自动合并。
4. 一个外部身份同一时刻只能映射一个本地用户。
5. 发现多个候选时进入人工冲突队列，不自动覆盖。

### 2.5 ExternalUserDepartment

保存用户和部门的多对多关系：

```text
(provider_id, external_user_id, external_department_id)
```

同时记录：

- 是否主部门；
- 首次发现时间；
- 最近发现时间；
- 是否已失效。

不要把部门 ID 序列化到 `users` 表的一个 JSON 字段中，否则无法可靠查询、对账和审计。

### 2.6 SyncRun 和 SyncError

每一次同步都必须有批次：

| 字段 | 说明 |
| --- | --- |
| `run_id` | 批次 ID |
| `provider_id` | 身份源 |
| `mode` | `inspect`、`dry-run`、`apply` |
| `cursor` | 增量游标或分页位置 |
| `started_at` / `ended_at` | 执行时间 |
| `status` | `running`、`success`、`partial`、`failed` |
| `counters` | 新增、更新、停用、冲突、失败数量 |
| `error_summary` | 脱敏后的概要 |

错误按对象记录，至少包含：

```text
run_id + object_type + external_id + error_code + retryable
```

## 3. 同步流程

```text
读取身份源配置
    |
    v
拉取部门全量或增量数据
    |
    v
校验树结构和外部 ID 唯一性
    |
    v
拉取用户及部门关系
    |
    v
规范化字段并计算差异
    |
    +--> 新增
    +--> 更新
    +--> 停用
    +--> 外部删除
    `--> 冲突
    |
    v
inspect/dry-run 输出报告
    |
    v
经批准后 apply
    |
    v
写审计和同步统计
```

## 4. 全量、增量和对账

### 全量同步

用于首次接入、游标失效、数据修复和定期对账。全量同步必须使用分页末页作为结束条件，不能仅凭某个 `total` 字段或固定页数停止。

### 增量同步

如果企业微信能力提供可靠的变更游标，使用游标保存位置；如果没有可靠游标，使用“时间窗口 + 去重 + 周期全量对账”的组合。

### 删除和失联

- 连续一次同步未发现不等于立即删除；
- 只有完成全量对账并确认列表完整后，才允许判定外部删除；
- 身份源请求失败时不执行大范围停用；
- 连续失败达到阈值后进入 `degraded` 状态并告警。

## 5. 状态传播模型

外部状态不能直接跳过中间层修改权限，必须沿着状态链传播：

```text
外部身份状态
    -> 身份映射状态
    -> 本地用户登录状态
    -> 空间成员状态
    -> 权限绑定状态
    -> 会话撤销状态
```

这里的“身份映射状态”描述绑定关系是否仍然可信，不等同于外部用户当前是否可用。`disabled` 默认保留映射关系，阻断授权但不删除绑定；只有经过完整对账确认的 `deleted` 才允许把映射关系置为 `revoked`。

### 5.1 可执行状态机

```text
active
  |-- 完整对账确认 disabled --> disabled
  |-- 完整对账确认 deleted  --> deleted
  |
  `-- 同步失败 -------------> active + provider_degraded

disabled
  |-- 完整对账确认 active --> active
  |-- 完整对账确认 deleted --> deleted
  |
  `-- 同步失败 ------------> disabled + provider_degraded

deleted
  `-- 外部重新出现 active --> 不能自动恢复，必须重新绑定或人工确认
```

单次请求失败、分页中断、游标失效或同步批次不完整，不能触发 `active -> deleted` 或 `disabled -> deleted`。同步失败只改变身份源或同步批次的健康状态，不改变外部用户的本地生命周期状态。

已经进入 `revoked` 的映射不能原记录复活。外部身份重新出现时，必须创建新的绑定记录，保留旧记录、旧的 `revoked_at` 和审计关系；新记录只有在重新匹配、人工确认和冲突检查通过后才能进入 `active`。因此“重新绑定”不是对旧 revoked 记录做自动恢复。

### 5.2 各层状态和本地处理

| 外部状态 | 身份映射 | 本地登录 | 空间成员 | 部门授权 | 会话 |
| --- | --- | --- | --- | --- | --- |
| `active` | 保留并标记可用 | 允许 | 只恢复同步拥有的成员状态 | 只恢复同步拥有的绑定 | 不强制撤销 |
| `disabled` | 保留绑定，授权状态阻断 | 禁止该身份登录 | 停用或撤销同步拥有的成员资格 | 立即失效同步拥有的部门授权 | 递增本地用户 `session_epoch`，撤销该本地用户的真人会话 |
| `deleted` | 完整对账确认后置为 `revoked` | 禁止该身份登录 | 撤销同步拥有的成员资格 | 撤销同步拥有的绑定 | 递增本地用户 `session_epoch`，撤销该本地用户的真人会话 |
| 同步失败 | 保持原映射和原状态 | 保持原状态 | 不执行批量停用 | 不执行批量撤销 | 不执行批量撤销，标记 `degraded` |

### 5.3 会话撤销和 fail-closed

一期明确采用本地用户级会话撤销版本，不把会话撤销版本放在单条 `identity_mapping` 上：

1. 本地用户维护 `session_epoch` 或等价的用户级撤销版本；Token 携带 `local_user_id` 和签发时的版本；
2. 任一绑定身份发生 `disabled`、`deleted`、解绑或重新绑定等影响登录可信度的变化时，递增本地用户版本，撤销该本地用户的全部真人 JWT；
3. 如果本地用户仍有另一条有效身份源，递增版本后允许通过该有效身份源重新登录；旧 Token 不能继续使用；
4. 后续请求同时检查本地用户状态、身份有效性和 Token 版本；
5. 版本不一致、身份不可用或撤销状态无法确认时，受保护请求拒绝；
6. 再执行 Token 缓存清理、会话列表撤销等辅助操作；
7. 如果会话撤销操作失败，身份仍保持阻断并进入重试，不能恢复放行，也不能把同步批次标记为完整成功。

这样可以覆盖一个本地用户绑定多个身份源的情况：任何影响该用户登录可信度的身份变化都会撤销其全部真人会话，而不是只递增某一条外部映射的版本。缓存清理是加速手段，持久化的本地用户状态和撤销版本才是授权判断依据。

API Key 不使用真人 Token 的 `session_epoch`。独立机器主体使用 API Key 自身的 active、过期、撤销和 scope 状态；绑定本地用户的 API Key 还要叠加本地用户状态，但仍保留 Key 级撤销能力。

### 5.4 同步失败、provider degraded 和 fail-closed 边界

`provider_health` 与外部用户生命周期必须分开：

| 情况 | 处理 |
| --- | --- |
| 外部身份已确认 `active`，本次同步失败 | 保留最后一次确认状态，不批量停用、不批量撤销 |
| 外部身份已确认 `disabled` 或 `deleted`，本次同步失败 | 继续阻断，不因失败恢复访问 |
| 本地映射冲突、未确认或没有可用的最后确认状态 | 受保护请求拒绝，不能猜测为 active |
| 本地用户状态、`session_epoch`、Tenant 成员、共享关系或 API Key 撤销状态无法读取 | 立即 fail-closed，拒绝受保护请求 |
| provider `degraded` 且最后确认状态为 active、仍在 `max_stale_age` 内 | 只有 `degraded_at` 之前签发、尚未过期且撤销检查通过的 Token 可以按最后确认状态继续；禁止新登录、Token 刷新、身份绑定、成员投影、权限提升和 apply |
| provider `degraded` 超过 `max_stale_age` | 所有依赖该外部身份事实的受保护请求拒绝 |

预研默认规则为：任一必需同步批次失败或不完整就进入 `degraded`，并记录当前降级周期的 `degraded_at`；降级期间的重复失败不刷新该时间。只有一次完整成功的全量对账，或经确认没有缺口的完整增量对账，才能恢复 `healthy`。恢复时清空当前 `degraded_at`，并将本次降级周期的起止时间写入同步健康审计。`max_stale_age` 的 `24h` 只是预研默认值，进入 POC 前必须由业务和安全评审确认具体值，确认前不能冻结为生产配置。

状态转换必须满足：

```text
healthy -> degraded:
    degraded_at = now

degraded -> degraded:
    degraded_at 不变

degraded -> healthy:
    归档本次 degraded_at 和恢复时间
    当前 degraded_at = null
```

恢复流程必须是：

```text
provider 恢复
    -> 完成全量或无缺口的完整对账
    -> 先处理 disabled/deleted/rebind 差异
    -> 再恢复 apply 和权限投影
    -> 清除 degraded
```

`degraded` 只表示外部事实暂时不可刷新，不表示用户自动停用，也不表示可以跳过本地撤销检查。任何本地安全状态不可确认，仍然优先 fail-closed。

恢复启用时，只恢复本次同步明确拥有的成员和部门授权字段，不覆盖人工角色、人工授权或 `break-glass` 权限。已经进入 `revoked` 的删除映射不能因为外部用户重新出现就自动复活，必须重新绑定并重新走冲突检查。

必须明确：

> 同步失败不等于外部用户删除，二者不能走同一处理路径。

状态传播还必须满足：

1. 状态变更可追踪到同步批次；
2. 停用和删除不物理删除业务数据；
3. 会话撤销完成前，授权计算不能继续放行；
4. 同步失败恢复后，先重新对账，再继续投影；
5. provider 健康状态不能覆盖用户已确认的 disabled/deleted 状态；
6. API Key 的撤销结果不能依赖真人 Token 的会话版本。

## 6. 幂等和并发

同步操作必须满足：

```text
同一批输入重复执行 = 最终状态相同 + 不重复创建用户/成员
```

实现约束：

1. 所有外部对象使用稳定唯一键；
2. 差异应用按对象和批次记录幂等键；
3. 同一个身份源同一时间只允许一个 apply 批次；
4. dry-run 不得产生会被 apply 误认的半成品数据；
5. 对数据库写入使用事务边界，但不要把整个组织同步包在一个超大事务中。

## 7. 本地投影策略

推荐分四步，P3 的成员投影必须建立在稳定的身份映射之上：

### 第一步：固定样本和内存模型

使用固定脱敏样本和内存模型验证部门树、用户关系、身份匹配和状态传播，不创建或修改本地空间成员。

### 第二步：身份映射 dry-run

根据已批准策略在内存中生成：

```text
external_user -> local_user -> tenant_member
```

只输出差异报告，不建表、不写入 WeKnora。

### 第三步：P3-A 持久化最小身份映射

在任何 `tenant_members` 写入之前，先评审并持久化最小身份映射。至少要能稳定识别：

```text
provider_id
external_user_id
local_user_id
match_method
mapping_status
last_verified_at
last_sync_run_id
```

这一步不要求同时持久化完整部门快照、原始响应或 `permission_bindings`，但不能省略稳定映射。一个外部身份在同一身份源中只能有一个 active 映射；冲突、撤销和未确认映射不能进入成员投影。

### 第四步：P3-B 受控投影

确认身份映射、单主 Tenant 策略、状态撤销和回滚规则后，才在 feature flag 下创建或更新 `tenant_members`。默认角色建议为 `viewer` 或 `contributor`，不能根据企业微信管理员标志自动授予 Owner。

每次 apply 必须记录同步拥有的字段、变更前值、目标值和变更后值。rollback 只撤销仍由本次同步拥有的变更：

- 如果当前值仍等于本次 apply 的目标值，可以恢复变更前值；
- 如果期间发生人工修改，进入冲突，不自动覆盖人工结果；
- 不恢复已过期或已被人工撤销的权限；
- 不删除本地用户、业务数据和审计记录。

## 8. 企业微信适配器边界

企业微信适配器只暴露规范化接口，例如：

```text
ListDepartments(cursor) -> DepartmentPage
ListUsers(cursor) -> UserPage
ListUserDepartments(user_id) -> DepartmentIDs
GetSyncCheckpoint() -> Checkpoint
```

适配器内部负责：

- access token 获取和缓存；
- API 限流；
- 分页；
- 临时错误重试；
- 外部字段到规范字段转换。

适配器外部不得暴露企业微信 SDK 类型，避免上层被厂商协议锁定。

## 9. 首个 POC 验收

POC 不写生产数据库，使用固定脱敏样本验证：

1. 部门树可重建；
2. 同一用户重复出现不会产生重复映射；
3. 用户跨多个部门时关系完整；
4. 用户停用会产生明确差异；
5. 外部 ID 变化和姓名变化不会错误创建新用户；
6. 部门移动不会丢失历史关系；
7. 分页中断后可重试；
8. 一次失败不会执行停用；
9. dry-run 报告可以重复生成且结果一致；
10. 一个本地用户绑定多个身份源时，任一影响登录可信度的状态变化都会撤销该用户全部真人会话；
11. revoked 外部身份重新出现时创建新 mapping，旧 mapping 保留且不会出现两个 active 映射；
12. provider `degraded` 时，只有 `degraded_at` 之前签发的 Token 在 `max_stale_age` 内可以按最后状态继续；`degraded_at` 之后签发或刷新的 Token 必须拒绝；
13. provider 恢复必须先完成完整对账，才能清除 degraded 并继续投影；
14. 本地用户状态、会话撤销版本或 API Key 撤销状态不可读时，受保护请求 fail-closed；
15. 已确认 disabled/deleted 的用户在同步失败期间仍然被阻断；
16. 同一 provider 下 `E1 -> U1` 后再出现 `E2 -> U1` 时，第二条映射进入 `conflict`，不能自动 active；
17. `degraded_at` 只在 `healthy -> degraded` 时设置，重复失败不刷新，恢复 `healthy` 后清空当前值并保留审计。
