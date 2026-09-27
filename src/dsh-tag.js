// dsh-tag.js — dsh 的安装/升级「发行标签」（dist-tag）解析（v1.9.1 新增）
//
// 背景（2026-09-27 实测事故：重启进 UAT 后"历史会话丢失"）：
//   安装与升级原先**硬编码 `@deepseek-ai/dsh@latest`**（launcher 首次安装、updater 升级各一处）。
//   而注册表上不同标签可能指向**不同版本**——实测：
//       latest = 0.1.5-rc.3      next = 0.1.7-rc.2      alpha = 0.1.7-alpha.2
//   主目录被手工升到 `next`（0.1.7-rc.2）后，UAT 重建/重装时又装回 `latest`（0.1.5-rc.3），
//   于是两个绿色目录跑着**不同版本的 dsh**。
//
//   关键危险在于：dsh 的 home 默认是 `~/.dsh`，**两个实例共用同一个 home**（本应用不设
//   DSH_HOME，见 launcher 的 spawnEnv 只叠加 ELECTRON_RUN_AS_NODE/PATH）。较旧的 dsh
//   会按自己的理解改写共享的 `settings.yaml` 与会话索引，表现为"历史会话丢失"
//   （实测：UAT 启动 13 秒后 `~/.dsh/settings.yaml` 被改名为 `settings.yaml.imported`）。
//
// 因此「版本对齐」是共用 home 的前提，而标签必须可配置：`DSH_DSH_TAG=next`
// 就能让所有实例跟同一条版本流，避免再次出现版本分叉。
'use strict';

const DEFAULT_TAG = 'latest';
const DEFAULT_REGISTRY = 'https://registry.npmmirror.com';

/** 标签合法性：只允许 npm 标签/版本号字符，杜绝把任意串塞进 npm 参数 */
const TAG_RE = /^[A-Za-z0-9._-]+$/;

/**
 * 本次要跟随的 dist-tag（或精确版本号）。
 * 环境变量 `DSH_DSH_TAG` 覆盖，缺省 `latest`（保持既有行为）。
 */
function dshDistTag() {
  const raw = String(process.env.DSH_DSH_TAG || '').trim();
  if (!raw) return DEFAULT_TAG;
  if (!TAG_RE.test(raw)) return DEFAULT_TAG;   // 非法值一律回退，不冒险拼进命令行
  return raw;
}

/** npm 注册表（镜像）地址，去掉尾部斜杠 */
function dshRegistry() {
  const raw = String(process.env.DSH_NPM_REGISTRY || '').trim();
  return (raw || DEFAULT_REGISTRY).replace(/\/+$/, '');
}

/** 安装/升级用的包规格，如 `@deepseek-ai/dsh@next` */
function dshInstallSpec() {
  return '@deepseek-ai/dsh@' + dshDistTag();
}

/** 版本查询端点：注册表按标签取版本（`/<pkg>/<tag>` 与 `/<pkg>/latest` 同构） */
function dshVersionUrl() {
  return dshRegistry() + '/@deepseek-ai/dsh/' + encodeURIComponent(dshDistTag());
}

/** 给人看的升级命令（设置页/日志文案用） */
function dshUpgradeCommand() {
  return 'npm i -g ' + dshInstallSpec();
}

module.exports = {
  dshDistTag, dshRegistry, dshInstallSpec, dshVersionUrl, dshUpgradeCommand,
  DEFAULT_TAG, DEFAULT_REGISTRY,
};
