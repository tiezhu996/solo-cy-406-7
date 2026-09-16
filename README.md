# 合同模板在线编辑器

面向法律从业者和企业法务的本地化合同起草工作台，支持模板管理、变量替换、条款复用、版本保存与差异对比。

## 功能列表

- 模板库：按合同分类、标签和关键词检索，支持创建、编辑、复制、删除模板。
- 模板编辑器：使用 TipTap 富文本编辑合同正文，右侧维护变量，底部条款库可插入复用条款。
- 合同实例：基于模板创建实例，填写变量后实时预览最终合同 HTML。
- 版本历史：为合同实例保存版本，左右双栏高亮对比内容差异。
- 条款库：按分类管理违约、争议解决、付款、知识产权等常用条款。
- 本地持久化：通过 IndexedDB 保存全部数据，并支持 JSON 导入导出。
- Undo/Redo：模板编辑器集成 Ctrl+Z / Ctrl+Y，并在状态管理中维护模板历史栈。
- 合同变更确认：仅对「已签署」合同开放**唯一登记入口**；登记后原合同继续有效，
  变更停在双方确认阶段。登记时为甲、乙各签发一枚不同的**一次性确认凭据**
  （库内仅存 SHA-256 哈希），确认/撤回必须出示对应凭据，无法通过切换身份替代；
  同一凭据重复提交不产生第二次效果，凭据错误或跨变更复用一律拒绝。双方各凭
  合法凭据确认一次后才在同一 IndexedDB 事务内生成新版本并替换当前正文，
  任一步失败整体回滚。

## 快速启动

```bash
cd frontend
npm install
npm run dev
```

开发服务器端口为 `28312`，访问 `http://localhost:28312`。

构建与预览：

```bash
npm run build
npm run preview
```

变更模块逻辑测试（纯状态机 + fake-indexeddb 真实事务，含并发赛跑与回滚用例）：

```bash
npm run test:amendments
```

## 合同变更确认模块

规则与一致性保证：

1. **唯一登记入口**：只有已签署合同实例页上的「登记变更」按钮可以创建变更；
   已签署合同的变量、正文与状态编辑被冻结。
2. **原合同继续有效**：登记后变更停在「待双方确认」，确认完成前合同正文不动。
3. **一次性凭据（防身份替代）**：登记成功时为甲方、乙方各签发一枚不同的凭据
   （`amd-a_…` / `amd-b_…`），明文只展示这一次，数据库只保存 SHA-256 哈希。
   界面不再提供「切换为甲方/乙方」的入口——持哪枚票就只能以哪一方操作。
4. **凭票确认**：只有凭据哈希与库内槽位匹配、且尚未使用时才能确认；同一枚凭据
   再次提交直接忽略，不产生第二次效果。双方各凭自己的合法凭据确认一次后才生效。
5. **凭票撤回即失效**：待确认阶段任一方凭据撤回，整条变更进入终态「已撤回」，
   该方凭据标记已用于撤回。
6. **凭据异常不变更状态**：凭据格式错误、哈希不符（含跨变更复用、他方凭据、换前缀冒充、
   末位篡改）一律拒绝；落库失败时事务 abort——合同正文、变更记录、版本号三者
   一起保持原样。失败结果带原因码（`CREDENTIAL_MALFORMED` / `CREDENTIAL_MISMATCH` /
   `CREDENTIAL_USED` / `TERMINAL_STATE` / `PERSISTENCE_FAILED`），操作处内联说明
   具体原因；成功、幂等忽略、拒绝三类结果判别返回、互不混淆。任何拒绝都不消耗
   凭据，错误清除后用合法凭据可继续完成确认或撤回，刷新后状态与失败前一致。
7. **反馈不依赖控制台**：store 的 `confirm/withdraw` 永不向 UI 抛异常，拒绝后先从
   IndexedDB 回读变更记录校正内存缓存，再在按钮下方就地提示，不会出现「按钮无反应、
   只有控制台报错」。
8. **生效原子性**：第二方凭据确认齐备时，`新版本写入 + 正文替换 + 变更记录推进`
   在同一个 IndexedDB `readwrite` 事务内完成。
9. **并发安全**：同一份合同的登记/确认/撤回通过 per-instance Promise 队列串行化，
   同一枚票并发双提交恰好一次有效；确认与撤回赛跑时只会落地一个终态。
10. **刷新一致**：全部状态落盘 IndexedDB，内存缓存仅在事务提交成功后更新，
    刷新后以数据库回读为准。
11. **版本迁移**：DB 升级到 v3；v2 的自报身份在途记录无凭据可对应，迁移时作废，
    终态记录补凭据占位槽，历史数据与版本号保留。

## 技术栈

| 类别 | 技术 |
| --- | --- |
| 前端框架 | React 18 + TypeScript |
| 构建工具 | Vite |
| UI 组件 | Arco Design |
| 状态管理 | Zustand |
| 富文本编辑 | TipTap |
| 本地数据库 | IndexedDB + idb |
| 差异对比 | diff |
| 路由 | React Router |
| 逻辑测试 | node:test + fake-indexeddb（仅 devDependency） |

## 目录结构

```text
frontend/
├── scripts/
│   └── amendment.test.ts        # 变更状态机/事务/并发/回滚/回读测试
└── src/
    ├── api/           # IndexedDB 数据访问入口
    ├── stores/        # template.ts, clause.ts, instance.ts, version.ts, amendment.ts
    ├── types/         # Template / Clause / ContractInstance / Version / Amendment / enums
    ├── components/
    │   ├── common/    # TemplateCard, RichEditor, VariableForm, CategoryFilter, VersionDiff
    │   ├── amendment/ # AmendmentPanel（确认/撤回/时间线）、RegisterAmendmentModal（唯一登记入口）
    │   ├── editor/    # 变量面板、条款抽屉、条款编辑器、编辑器工具栏
    │   └── preview/   # 合同预览组件
    ├── hooks/         # useIndexedDB, useHistory, useVariableReplace
    ├── pages/         # TemplateList, TemplateEditor, InstanceEditor, VersionCompare, ClauseList
    ├── router/        # 路由和应用布局
    ├── styles/        # 全局样式
    └── utils/
        ├── db.ts                  # schema v3（amendments 凭据模型 + byInstance 索引 + 版本迁移）
        ├── amendmentMachine.ts    # 纯函数状态机：登记/凭票动作/生效
        ├── amendmentCredential.ts # 一次性凭据签发、SHA-256、前缀解析、常量时间比较
        ├── amendmentMigrate.ts    # v2 自报身份记录 → v3 凭据模型迁移
        ├── amendmentTx.ts         # 验票 + 单事务原子提交 + per-instance 串行锁
        └── diff, export, seed
```

## License

MIT
