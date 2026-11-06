#!/usr/bin/env node
/**
 * 在 Windows 上产出 macOS 的 .app / .dmg。
 *
 * 为什么需要脚本：Windows 本机编不了 macOS 安装包（需要 Xcode CLT、hdiutil、codesign），
 * 只能用 GitHub Actions 的 macOS runner 打包，再把 artifact 下载到本地。
 *
 * 前置：gh 可用且已登录（`gh auth login` 或 GH_TOKEN 环境变量），对目标仓库有写权限。
 *
 * 用法：
 *   node scripts/macos-dmg.mjs                                   # 推 ci/macos-dmg 分支到 origin
 *   node scripts/macos-dmg.mjs --remote=fork --target=main       # 推到 fork 的默认分支（推荐）
 *   node scripts/macos-dmg.mjs --repo=owner/repo --out=dist-macos
 *
 * 参数：--branch（本地临时分支）、--target（远端目标分支）、--remote（git remote）、
 *       --repo（gh 目标仓库，默认从 remote URL 推导）、--out（下载目录）。
 * 注意：workflow_dispatch 要求 workflow 文件出现在默认分支上，所以用 fork 时推 main。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const args = new Map(
  process.argv.slice(2).map((s) => {
    const [k, ...v] = s.replace(/^--/, "").split("=");
    return [k, v.join("=") || ""];
  }),
);
const branch = args.get("branch") || "ci/macos-dmg";
const remote = args.get("remote") || "origin";
const target = args.get("target") || branch;
const outDir = resolve(args.get("out") || "dist-macos");

function call(cmd, cmdArgs, { capture = false, allowFail = false } = {}) {
  // 不走 shell：Windows 下 cmd.exe 会把 -m "CI: ... 构建" 这类含空格的中文参数拆成多个 pathspec
  const exe = process.platform === "win32" && (cmd === "gh" || cmd === "git") ? `${cmd}.exe` : cmd;
  const r = spawnSync(exe, cmdArgs, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (!allowFail && r.status !== 0) {
    throw new Error(`${cmd} ${cmdArgs.join(" ")} 失败（exit ${r.status}）\n${r.stderr || ""}`);
  }
  return r.status === 0 ? (capture ? r.stdout.trim() : "ok") : null;
}
const ghRaw = (a, o) => call("gh", a, o);
const git = (a, o) => call("git", a, o);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let gh = ghRaw; // 解析出目标仓库后统一注入 --repo

function die(msg) {
  console.error(`\n[中止] ${msg}\n`);
  process.exit(1);
}

console.log(`远端：${remote}  本地分支：${branch}  目标分支：${target}  产物：${outDir}`);

// 1. 前置检查
if (!call("gh", ["--version"], { capture: true, allowFail: true })) {
  die("未找到 gh（GitHub CLI），请先安装：https://cli.github.com/");
}
const login = ghRaw(["api", "user", "--jq", ".login"], { capture: true, allowFail: true });
if (!login) die("GitHub 未认证，请先 `gh auth login`（或设置 GH_TOKEN）");
console.log(`已认证账号：${login}`);

// gh 默认按 origin 决定仓库；用 fork 时必须显式指向 fork，否则会去操作 upstream
function parseRepo(url) {
  const m = String(url || "").match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}
const remoteUrl = git(["remote", "get-url", remote], { capture: true, allowFail: true });
const targetRepo = args.get("repo") || parseRepo(remoteUrl);
if (!targetRepo) die(`无法从 remote ${remote} 解析 GitHub 仓库，请显式传 --repo=owner/repo`);
gh = (a, o) => ghRaw([...a, "--repo", targetRepo], o);
console.log(`目标仓库：${targetRepo}`);

// gh repo view 用位置参数指定仓库，不支持 --repo
const repoJson = ghRaw(["repo", "view", targetRepo, "--json", "nameWithOwner,viewerPermission"], {
  capture: true,
  allowFail: true,
});
if (!repoJson) die("无法读取仓库信息，确认 --repo / --remote 正确");
const repo = JSON.parse(repoJson);
console.log(`仓库：${repo.nameWithOwner}（权限：${repo.viewerPermission}）`);
if (!["ADMIN", "MAINTAIN", "WRITE"].includes(repo.viewerPermission)) {
  die(
    `对 ${repo.nameWithOwner} 没有写权限。可先 \`gh repo fork --remote-name fork --clone=false\`，\n` +
      "再用 --remote=fork --target=main 重新运行本脚本。",
  );
}

// 2. 把两个 workflow 提交到本地临时分支（不动本地 main，也不带入其他本地改动）
const files = [".github/workflows/release.yml", ".github/workflows/macos-dmg.yml"];
for (const f of files) {
  if (!existsSync(resolve(f))) die(`缺少 ${f}`);
}
git(["checkout", "-B", branch]);
git(["add", "--", ...files]);
const staged = git(["diff", "--cached", "--name-only"], { capture: true });
if (staged) {
  git(["commit", "-m", "CI: 增加 macOS app/dmg 构建"]);
  console.log("已提交 workflow 改动");
} else {
  console.log("workflow 无新增改动，沿用分支上已有版本");
}
// 优先用 gh 的登录 token：更新 .github/workflows 需要 workflow scope，
// 而 credential manager 里的旧 PAT 可能只有 repo scope，会被引擎拒绝。
const authToken = process.env.GH_TOKEN || ghRaw(["auth", "token"], { capture: true, allowFail: true });
if (authToken) {
  // GitHub git HTTP 端点只认 basic：x-access-token:<token>，用 Bearer 会 401
  const basic = Buffer.from(`x-access-token:${authToken}`).toString("base64");
  git([
    "-c",
    "credential.helper=",
    "-c",
    `http.extraheader=AUTHORIZATION: basic ${basic}`,
    "push",
    remote,
    `HEAD:${target}`,
  ]);
} else {
  git(["push", remote, `HEAD:${target}`]);
}

// 3. 触发仅构建 macOS 的 workflow
const beforeJson = gh(
  ["run", "list", "--workflow", "macos-dmg.yml", "--limit", "1", "--json", "databaseId"],
  { capture: true, allowFail: true },
);
const before = beforeJson ? JSON.parse(beforeJson)[0]?.databaseId ?? 0 : 0;
gh(["workflow", "run", "macos-dmg.yml", "--ref", target]);
console.log("已触发 macOS DMG 构建，等待 run 出现…");

let runId = 0;
for (let i = 0; i < 30; i++) {
  sleep(5000);
  const listJson = gh(
    ["run", "list", "--workflow", "macos-dmg.yml", "--limit", "10", "--json", "databaseId,headBranch"],
    { capture: true, allowFail: true },
  );
  if (!listJson) continue;
  const hit = JSON.parse(listJson).find((r) => r.headBranch === target && r.databaseId > before);
  if (hit) {
    runId = hit.databaseId;
    break;
  }
}
if (!runId) die("没找到新触发的 run，可到 GitHub Actions 页面查看");
console.log(`run id：${runId}`);

// 4. 等待完成并下载
const watched = gh(["run", "watch", String(runId), "--exit-status", "--interval", "20"], {
  allowFail: true,
});
if (watched === null) {
  console.error(`\n构建失败，查看日志：gh run view ${runId} --repo ${targetRepo} --log-failed\n`);
  process.exit(1);
}
gh(["run", "download", String(runId), "--name", "macos", "--dir", outDir]);

const dmgs = readdirSync(outDir, { recursive: true })
  .filter((f) => String(f).endsWith(".dmg"))
  .map((f) => join(outDir, String(f)));
if (!dmgs.length) die(`下载完成但没有找到 .dmg，检查 ${outDir}`);
console.log("\n完成，产物：");
for (const d of dmgs) console.log(`  ${d}`);
