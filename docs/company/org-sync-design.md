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
| `current_snapshot_version` | 已接受的最新完整来源快照版本，单调递增，不因回滚倒退 |
| `scope_version` / `config_version` | 外部可见范围及适配器配置版本 |
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
| `snapshot_version` / `record_version` | 来源快照与本地单调记录版本 |

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
| `last_verified_at` | 生命周期及相关部门事实最近一次被可靠外部证据确认的时间 |
| `snapshot_version` / `record_version` | 来源快照与本地单调记录版本 |
| `visibility_state` | `in_scope`、`out_of_scope`、`unknown`，不等同于生命周期 deleted |

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
| `last_verified_at` | 关联身份事实的外部确认时间，不是本地审批/写入时间 |
| `record_version` / `last_change_id` | 并发校验和变更归属，任何修改都更新 |
| `supersedes_mapping_id` | 重新绑定时指向旧映射 |
| `rebind_reason` | 重新绑定原因和审批摘要 |

安全规则：

1. 自动匹配只能使用明确的可验证规则。
2. 邮箱匹配须检查唯一性、域名策略、外部邮箱可信证据及本地账号归属证明。基线注册接受提交邮箱，不等于本地邮箱已验证；仅“字符串相同”只能产生候选。
3. 姓名相同不能自动合并。
4. 一个外部身份同一时刻只能映射一个本地用户。
5. 发现多个候选时进入人工冲突队列，不自动覆盖。
6. 证明不足时必须人工确认或双侧受控验证，记录证据类型和摘要；不能因为邮箱来自企业目录就自动接管已有本地账号。

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
| `snapshot_version` | 在开始拉取前分配的来源采集代次 |
| `scope_version` / `config_version` | 本次输入使用的范围和配置版本 |
| `complete` / `completeness_evidence` | 分页、游标、范围核对的完整性证据摘要 |

批次不等于可执行计划。dry-run 输出不可变 `SyncPlan`，至少记录 `plan_id`、`plan_hash`、来源快照/配置/范围版本、目标记录和字段版本、所有权、策略版本、审批有效期与批准的精确差异。审批绑定该 hash；输入变化后必须生成新计划和新审批，不在 apply 时静默改算。

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
- 完整分页只证明读取了当前可见范围，不证明外部企业中所有用户均存在于列表；列表消失默认标记 `visibility_state=unknown/out_of_scope`，不能直接置为 deleted；
- 判定删除还须稳定的 `scope_version`、可见范围未缩小的证据，以及身份源提供的明确删除事件或权威单用户删除查询结果；停用事件只证明 disabled，不证明 deleted。没有这些证据只输出冲突/待确认差异；
- 已确认超出管理范围时，可按批准策略撤销该范围的同步贡献，但须记录 `scope_removed`，不能伪称企业离职；未知范围冻结新增授权并告警，已有授权只在事实时效内使用；
- 身份源请求失败时不执行大范围停用；
- 任一必需批次失败/不完整即进入 degraded；连续失败阈值仅用于告警升级，不推迟第 5.4 节的降级时点。

## 5. 状态传播模型

必须区分三个不同事件：本地账号封禁、单条外部身份失效、用户全部旧凭证撤销。传播链不是“某来源停用 -> 永久禁用本地账号”：

```text
外部身份状态
    -> 该来源映射和授权贡献
    -> 有效成员贡献重算
    -> 用户全部旧真人会话及绑定 Key 撤销
    -> 有效来源重新认证后逐请求计算

本地账号封禁
    -> 全部真人路径及绑定用户 Key 硬阻断
```

映射状态描述绑定是否可信，不等同于外部身份是否可用。disabled 保留绑定但该来源不可用于认证或授权；deleted 须符合第 4 节的权威证据后才置为 revoked。企业全局离职/安全封禁必须由明确的本地账号策略或批准事件设置 `local_user_blocked`；不能从某一来源停用推断全部来源都已失效。

### 5.1 可执行状态机

```text
active
  |-- 权威证据确认 disabled --> disabled
  |-- 完整范围核对及权威证据确认 deleted --> deleted
  |
  `-- 同步失败 -------------> active + provider_degraded

disabled
  |-- 更新的有效快照确认 active --> active
  |-- 完整范围核对及权威证据确认 deleted --> deleted
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
| `active` | 保留绑定且来源可用 | 可经该来源认证 | 只恢复该来源拥有的贡献 | 只恢复该来源拥有的绑定 | 不复活任何已撤销旧凭证 |
| `disabled` | 保留绑定，来源不可用 | 禁止该来源登录 | 撤销该来源贡献，保留其他有效/人工贡献 | 该来源部门授权立即失效 | 撤销用户全部旧真人会话和绑定用户 Key |
| `deleted` | 权威证据确认后 revoked | 禁止该来源登录 | 撤销该来源贡献，保留其他有效/人工贡献 | 撤销该来源绑定 | 撤销用户全部旧真人会话和绑定用户 Key |
| 同步失败 | 保持原映射和原状态 | 保持原状态 | 不执行批量停用 | 不执行批量撤销 | 不执行批量撤销，标记 `degraded` |

### 5.3 会话撤销和 fail-closed

一期采用本地用户级全量撤销语义，优先复用基线 `RevokeTokensByUserID`、Token 记录及 `ValidateToken` 检查，不预先锁定新增 `session_epoch`：

1. 会话明确记录认证方式、来源 provider、mapping、签发时间、当前 Tenant 和撤销引用；来源不能由请求参数选择；
2. 任一绑定身份发生 disabled/deleted/解绑/rebind 时，撤销该用户全部旧 access/refresh Token，包括经其他来源签发的旧 Token；
3. 本地账号未封禁且还有另一条有效来源时，撤销完成后可通过该来源重新登录；旧 Token 不自动换来源；
4. 后续请求检查本地账号、当前会话来源的状态和事实时效、会话撤销，以及逐路径范围和授权；一期只使用选定来源的外部部门贡献；
5. Token 记录已撤销、扩展版本不一致、选定身份不可用或撤销状态无法确认时拒绝；
6. 再执行 Token 缓存清理、会话列表撤销等辅助操作；
7. 如果会话撤销操作失败，身份仍保持阻断并进入重试，不能恢复放行，也不能把同步批次标记为完整成功。

状态变更与旧凭证撤销在同一事务完成，或先提交可逐请求读取的 `revocation_pending` 阻断再重试撤销；完成前禁止该用户继续访问或签发新凭证。并发登录/刷新须使用同一用户撤销屏障，不能在扫描撤销旧 Token 后、提交状态变更前签发漏网 Token。P3-A 验证现有机制是否足够，不足时再评审用户级版本扩展。缓存清理仅加速，不代替持久化检查。

接受包含失效身份的新来源事实时，必须同步建立上述用户阻断/撤销屏障，不能等普通计划审批才阻止已知失效身份。停用/删除的受控安全收缩可以立即执行并审计；重新启用和权限扩大仍要求新事实及审批，不能复用旧审批。

一条 `tenant_members` 记录不能直接编码多个来源的所有权：候选贡献账本分别记录 `manual/P1/P2` 的角色和状态，投影只重算有效贡献。某来源停用不能把人工或 P2 贡献整行撤销；管理员人工 suspended 也不能被来源 active 自动恢复。请求额外限制到当前认证来源和人工贡献，不能让聚合角色混入其他来源能力。

API Key 独立于真人 Token 撤销。一期保守撤销用户全部旧绑定 Key；新 Key 重新审批并声明有效身份依赖，只使用该来源的授权。本地账号封禁使所有绑定 Key 无效；独立机器 Key 不受某个人身份停用影响，仍按自己的主体、范围、过期和撤销判断。用户绑定模型及贡献账本均为待实施扩展，不是基线已有能力。

固定多来源反例：U8 的 P1 已 disabled、P2 active。旧 P1/P2 会话和所有旧绑定 Key 均拒绝；P2 新登录可访问 P2 绑定的 K3，不能读取仅有 P1:D1 授权的 K1；本地封禁后 P2 新登录也拒绝。

### 5.4 同步失败、provider degraded 和 fail-closed 边界

`provider_health` 与外部用户生命周期必须分开：

| 情况 | 处理 |
| --- | --- |
| 外部身份已确认 `active`，本次同步失败 | 保留状态，但请求必须检查该身份事实的 `now - last_verified_at`，不等于无限期可用 |
| 外部身份已确认 `disabled` 或 `deleted`，本次同步失败 | 继续阻断，不因失败恢复访问 |
| 本地映射冲突、未确认或没有可用的最后确认状态 | 受保护请求拒绝，不能猜测为 active |
| 本地账号、会话撤销、Tenant 成员、共享关系或 API Key 撤销状态无法读取 | 依赖该状态的请求立即 fail-closed |
| provider degraded 且最后确认 active | 只有事实年龄及降级年龄均不超过 `max_stale_age`、降级前签发且未撤销未过期的旧 Token 才可能继续；禁止新登录、刷新、绑定、成员投影、权限提升和普通 apply |
| `now - last_verified_at` 或降级持续时间超限 | 依赖该来源的受保护请求拒绝；最后 active 标记不豁免时效 |

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
    -> 用专用恢复计划先处理停用/撤销等收缩差异
    -> 完成用户旧凭证撤销及来源版本发布
    -> 清除 degraded
    -> 新审批后恢复普通 apply 和权限提升
```

降级期间仅受控安全收缩/恢复计划可例外执行：权威停用/删除事件可立即建立阻断及撤销；清除 degraded 的恢复计划必须基于新完整对账。二者都要第 6 节版本校验，不恢复凭证或授予新权限。恢复失败继续 degraded。事实年龄与降级年龄的公式以 [permission-design.md](./permission-design.md) 第 6.2 节为准。

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
6. API Key 的撤销结果不能依赖真人 Token 的会话版本；
7. 外部确认时间不因本地审批、apply 或 provider 其他用户的成功刷新而延长。

## 6. 幂等、版本栅栏和审批并发

同步操作必须满足：

```text
同一批输入重复执行 = 最终状态相同 + 不重复创建用户/成员
```

实现约束：

1. 所有外部对象使用稳定唯一键；
2. 差异应用按对象和批次记录幂等键；
3. 同一个身份源同一时间只允许一个 apply 批次；互斥只保证串行，不证明串行执行的输入足够新；
4. dry-run 不得产生会被 apply 误认的半成品数据；
5. 对数据库写入使用事务边界，但不要把整个组织同步包在一个超大事务中。

### 6.1 来源快照版本

每次采集在发出第一条请求前分配单调 `snapshot_version`，不能在返回时才编号。候选快照经分页、可见范围和完整性验证后，只有版本大于 `current_snapshot_version` 才可被接受；迟到的低版本采集不能覆盖新状态。无可靠外部版本时，默认同 provider 的采集也串行，使用本地采集代次、范围 hash、游标及证据摘要；`source_updated_at` 只能辅助检查，不能作为唯一顺序证明。

已确认的停用/删除证据也要推进该身份记录版本和安全事件序列；过时完整快照不能覆盖较新的单用户收缩事件。游标重置、范围或配置变更推进对应版本，使所有旧计划失效。此规则防止已知的新事实被旧计划覆盖，不声称本地版本能发现尚未采集到的外部变化；计划有效期超限或审批后需重新确认时必须重新拉取、生成并审批计划。

### 6.2 apply 前置条件和 CAS

每个计划至少固定：

```text
plan_id + plan_hash + provider_id + snapshot_version
    + scope_version + config_version + policy_version
    + approval_expires_at

per change:
    target_id + source_record_version + security_event_version
    + expected_record_version + expected_field_version
    + expected_owner + expected_last_change_id + before + after
    + change_id + idempotency_key
```

apply 在 provider 锁内先校验整份计划：

1. 审批有效且 hash 完全一致；当前来源快照、范围、配置和策略版本均等于计划版本，完整性证据仍有效；
   来源对象版本和安全事件版本也须一致；在快照采集期间或之后到达的停用/删除事件使该对象的旧 active 输入失效，不能基于旧快照重新生成“新”恢复计划；
2. 每个目标的版本、字段所有权和上次变更 ID 均匹配；同步不拥有的字段拒绝写入；
3. 任何不匹配都标记 `stale_plan` 或 `conflict`，不修改数据库，不允许仅“重新批准”旧差异；重新生成计划再审批；
4. 每个对象写入使用 compare-and-swap（CAS），在更新时再次检查版本和所有权，并递增记录/字段版本、写入 `last_change_id`；
5. 多对象计划执行期间发生竞争则停止后续步骤，标记 `partial/conflict`，记录已提交对象；不把未执行步骤自动重放为新目标，不标记 success；
6. 幂等重试只确认同一个 `change_id` 的已提交结果；若之后被他人修改则返回冲突，不重新写回原目标。

provider 互斥须覆盖来源版本接受和 apply 的版本校验/提交；目标对象还须 CAS 防止人工写入竞争。审批在锁外等待，不持锁等待人审批。角色、成员、绑定及管理界面的所有写入路径均要更新版本和变更归属，否则版本设计不能宣称有效。

固定反例：

```text
A: snapshot=10，计划 U1 active，目标 version=7，等待审批
B: snapshot=11，确认 U1 disabled，apply 后目标 version=8
A: 获批尝试 apply
结果: stale_plan，零写入；U1 保持 disabled，旧会话/Key 保持撤销
```

P1-P2 用内存模型验证顺序和冲突；P3-A 在任何实际投影前评审最小版本/计划/贡献元数据的持久化方案，不要求立即持久化完整外部快照。

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

### 第三步：P3-A 持久化最小身份及一致性元数据

在任何 `tenant_members` 写入之前，先评审并持久化最小身份映射。至少要能稳定识别：

```text
provider_id
external_user_id
local_user_id
match_method
mapping_status
last_verified_at
last_sync_run_id
record_version
last_change_id
```

这一步不要求完整部门快照、原始响应或 permission_bindings，但不能省略稳定映射及第 6 节的来源版本、计划和变更归属元数据。一个外部身份在同一来源最多一个 active 映射；冲突、revoked 和未确认映射不能投影。进入 P3-B 前还须评审来源贡献和人工贡献的持久化边界。

### 第四步：P3-B 受控投影

确认身份映射、单主 Tenant 策略、状态撤销和回滚规则后，才在 feature flag 下创建或更新 `tenant_members`。默认角色建议为 `viewer` 或 `contributor`，不能根据企业微信管理员标志自动授予 Owner。

每次 apply 记录同步拥有的字段、前后值、前后记录/字段版本、`change_id` 和所有权。rollback 不是恢复旧快照的后门，须满足：

- 当前值等于 apply 目标值只是必要条件；还须当前记录/字段版本等于该 change 的变更后版本、`last_change_id` 相同、所有权仍属于本次同步；
- 任意人工/其他批次修改，即使值后来变回相同目标值，也进入 `rollback_conflict`，不得覆盖（ABA 回归）；
- rollback 自身用 CAS 写入新版本和新的变更 ID，不把版本减回旧值；已经回滚的 change 不重复恢复；
- 已确认 disabled/deleted、已撤销会话/Key 和新的安全阻断不因 rollback 恢复；需要重新启用时消费更新的外部事实并走新计划和审批；
- 某条来源贡献回滚不能删除其他来源或人工贡献；目标删除/重建、关联父对象版本变化或新策略收缩同样进入冲突；
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
12. provider degraded 时，事实年龄与降级年龄均不过限且降级前签发的旧 Token 才可能继续；降级后签发/刷新或任一年龄超限必须拒绝；
13. provider 恢复必须先完成完整对账，才能清除 degraded 并继续投影；
14. 本地用户状态、会话撤销版本或 API Key 撤销状态不可读时，受保护请求 fail-closed；
15. 已确认 disabled/deleted 的用户在同步失败期间仍然被阻断；
16. 同一 provider 下 `E1 -> U1` 后再出现 `E2 -> U1` 时，第二条映射进入 `conflict`，不能自动 active；
17. `degraded_at` 只在 `healthy -> degraded` 时设置，重复失败不刷新，恢复 `healthy` 后清空当前值并保留审计。
18. 最后确认 active 25 小时、降级 2 小时、未过期降级前 Token 必须拒绝；恰好 24 小时、超过边界、缺失/未来确认时间分别有结果；
19. P1 disabled、P2 active 的 U8 能经 P2 重新登录，但只能使用 P2 和有效人工贡献；全部旧会话及绑定 Key 均保持撤销；
20. A 的旧 active 计划在 B 的新 disabled 已执行后 apply 为 `stale_plan`，即使两次 apply 串行也不得恢复；
21. 旧采集晚返回、审批过期、scope/config/policy 改变、人工写入和幂等重试遇到后续修改均有冲突结果；
22. 值变为人工 admin 再改回相同 contributor 的 ABA 场景，rollback 必须拒绝；安全停用和旧凭证绝不因回滚恢复；
23. 完整列表因外部可见范围缩小而缺失用户时，不自动判 deleted；仅邮箱相同但归属证据不足时不自动绑定；
24. 状态提交、并发登录/刷新、撤销失败和恢复计划失败均不产生仍可用的漏网旧凭证。
