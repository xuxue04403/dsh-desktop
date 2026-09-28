// dsh-tag.js — dsh 的安装/升级「发行标签」（dist-tag）解析（v1.9.1 新增；v1.9.2 改为多候选）
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
// v1.9.2 起：**不再"跟随某一个标签"，而是同时评估多个候选标签、取版本最高者**
//   （实测 2026-09-29：`latest` 追平到 0.1.7-rc.2，而 `next` 前进到 0.2.0-rc.1 ——
//   只跟 `latest` 的实现会永远看不到发在 `next` 上的新版本）。
//   候选缺省为 `['latest', 'next']`；某个标签查询失败只影响它自己，不影响其余候选。
//
// 显式钉住：设 `DSH_DSH_TAG=<标签或精确版本>` 时**只**评估该标签（不再自动取高者），
//   用于"我就想固定在某个通道"的场景。非法值按"未指定"处理（回退到多候选）。
'use strict';

const DEFAULT_TAG = 'latest';
const DEFAULT_REGISTRY = 'https://registry.npmmirror.com';

/** 未显式指定时评估的候选标签（取版本最高者）。顺序只影响日志展示，不影响选择。 */
const CANDIDATE_TAGS = ['latest', 'next'];

/** 标签合法性：只允许 npm 标签/版本号字符，杜绝把任意串塞进 npm 参数 */
const TAG_RE = /^[A-Za-z0-9._-]+$/;

/**
 * 显式钉住的标签/版本（环境变量 `DSH_DSH_TAG`）。
 * @returns {string|null} 合法值原样返回；未设置或非法一律 null（= 未指定）。
 */
function explicitTag() {
  const raw = String(process.env.DSH_DSH_TAG || '').trim();
  if (!raw) return null;
  return TAG_RE.test(raw) ? raw : null;
}

/**
 * 本次用于**安装**的标签（首次安装、以及没有可用网络比较时的兜底文案）。
 * 显式钉住时用它；否则用稳定通道 `latest`。
 *
 * 注意：首次安装刻意不在这里发起网络查询——一是 launcher 与 updater 之间有依赖方向
 * （updater 需要 launcher 的 compareVersions），二是"能不能装成"不该被一次查询失败拖住。
 * 若 `next` 上的版本更高，紧接着的启动检查会立刻把它升上去（自我纠正，多花一次安装）。
 */
function dshDistTag() {
  return explicitTag() || DEFAULT_TAG;
}

/**
 * 需要评估的候选标签集合。
 * 显式钉住 → 只有它一个；否则为 {@link CANDIDATE_TAGS}。
 */
function dshCandidateTags() {
  const one = explicitTag();
  return one ? [one] : CANDIDATE_TAGS.slice();
}

/** npm 注册表（镜像）地址，去掉尾部斜杠 */
function dshRegistry() {
  const raw = String(process.env.DSH_NPM_REGISTRY || '').trim();
  return (raw || DEFAULT_REGISTRY).replace(/\/+$/, '');
}

/** 指定标签的版本查询端点（`/<pkg>/<tag>` 与 `/<pkg>/latest` 同构） */
function dshVersionUrlFor(tag) {
  return dshRegistry() + '/@deepseek-ai/dsh/' + encodeURIComponent(String(tag));
}

/** 缺省标签的版本查询端点（兼容旧调用） */
function dshVersionUrl() {
  return dshVersionUrlFor(dshDistTag());
}

/** 按 标签/精确版本 生成安装规格，如 `@deepseek-ai/dsh@next`、`@deepseek-ai/dsh@0.2.0-rc.1` */
function dshInstallSpecFor(tagOrVersion) {
  const t = String(tagOrVersion == null ? '' : tagOrVersion).trim();
  return '@deepseek-ai/dsh@' + (TAG_RE.test(t) ? t : dshDistTag());
}

/** 首次安装用的包规格 */
function dshInstallSpec() {
  return dshInstallSpecFor(dshDistTag());
}

/** 给人看的升级命令（设置页/日志文案用）；可指定标签或精确版本 */
function dshUpgradeCommandFor(tagOrVersion) {
  return 'npm i -g ' + dshInstallSpecFor(tagOrVersion);
}

function dshUpgradeCommand() {
  return dshUpgradeCommandFor(dshDistTag());
}

module.exports = {
  dshDistTag, dshCandidateTags, dshRegistry,
  dshInstallSpec, dshInstallSpecFor,
  dshVersionUrl, dshVersionUrlFor,
  dshUpgradeCommand, dshUpgradeCommandFor,
  explicitTag,
  DEFAULT_TAG, DEFAULT_REGISTRY, CANDIDATE_TAGS,
};
