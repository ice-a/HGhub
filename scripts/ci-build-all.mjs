#!/usr/bin/env node
/**
 * 触发远端仓库的「Windows + macOS + Android」三平台自动构建，并把产物下载到本地。
 *
 * 为什么：Windows 本机编不了 macOS 包，Android 交叉编译链路也重；统一交给
 * .github/workflows/release.yml 在三个 runner 上并行构建。
 *
 * 触发方式（仓库侧，无需本脚本）：
 *   push 到 main               → 自动构建三平台，上传 artifacts
 *   push tag v*                → 自动构建三平台 + 发布 GitHub Release
 *   Actions 页手动运行          → 自动构建三平台，上传 artifacts
 * 本脚本用于「立刻跑一次 + 把产物拉回本地」，或重跑/续传某次 run。
 *
 * 前置：gh 已登录且 token 带 workflow scope（更新 .github/workflows 必需）。
 *   gh auth login --web --scopes "repo,workflow,read:org"
 *   export GH_TOKEN="$(gh auth token)"
 *
 * 用法：
 *   node scripts/ci-build-all.mjs --remote=fork --target=main
 *   node scripts/ci-build-all.mjs --run-id=42202806069          # 只等待并下载已有 run
 *   node scripts/ci-build-all.mjs --out=dist-ci --remote=fork
 *
 * 参数：--remote、--target、--branch、--repo、--out、--workflow、--run-id。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const args = new Map(
  process.argv.slice(2).map((s) => {
    const [k, ...v] = s.replace(/^--/, "").split("=");
    return [k, v.join("=") || ""];
  }),
);
const remote = args.get("remote") || "fork";
const target = args.get("target") || "main";
const branch = args.get("branch") || "ci/auto-build";
const workflow = args.get("workflow") || "release.yml";
const outDir = resolve(args.get("out") || "dist-ci");
const runIdArg = Number(args.get("run-id") || 0);

function call(cmd, cmdArgs, { capture = false, allowFail = false } = {}) {
  // 不走 shell：Windows 下 cmd.exe 会拆散含空格的中文 commit message
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
const die = (msg) => {
  console.error(`\n[中止] ${msg}\n`);
  process.exit(1);
};

console.log(`远端：${remote}  目标分支：${target}  workflow：${workflow}  产物：${outDir}`);

const login = ghRaw(["api", "user", "--jq", ".login"], { capture: true, allowFail: true });
if (!login) die("GitHub 未认证，请先 gh auth login 或设置 GH_TOKEN");
console.log(`已认证账号：${login}`);

function parseRepo(url) {
  const m = String(url || "").match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}
const remoteUrl = git(["remote", "get-url", remote], { capture: true, allowFail: true });
const targetRepo = args.get("repo") || parseRepo(remoteUrl);
if (!targetRepo) die(`无法从 remote ${remote} 解析仓库，请显式传 --repo=owner/repo`);
const gh = (a, o) => ghRaw([...a, "--repo", targetRepo], o);
console.log(`目标仓库：${targetRepo}`);

const repoJson = ghRaw(["repo", "view", targetRepo, "--json", "nameWithOwner,viewerPermission"], {
  capture: true,
  allowFail: true,
});
if (!repoJson) die("无法读取仓库信息");
const repo = JSON.parse(repoJson);
if (!["ADMIN", "MAINTAIN", "WRITE"].includes(repo.viewerPermission)) {
  die(`对 ${repo.nameWithOwner} 没有写权限`);
}

let runId = runIdArg;

if (!runId) {
  // 1. 只把 workflow / 脚本 / .gitignore 提交到专用分支，避免带入其它本地改动
  const files = [
    `.github/workflows/${workflow}`,
    ".github/workflows/macos-dmg.yml",
    "scripts/ci-build-all.mjs",
    "scripts/macos-dmg.mjs",
    ".gitignore",
  ].filter((f) => existsSync(resolve(f)));
  git(["checkout", "-B", branch]);
  git(["add", "--", ...files]);
  const staged = git(["diff", "--cached", "--name-only"], { capture: true });
  if (staged) {
    git(["commit", "-m", "CI: 三平台自动构建（Windows / macOS / Android）"]);
    console.log(`已提交：\n${staged}`);
  } else {
    console.log("无新增改动，沿用分支上已有版本");
  }

  // 2. 与远端对齐后再推，避免非快进被拒
  git(["fetch", remote, target]);
  // 注意：--is-ancestor 成功时 stdout 为空，必须判 null（失败）而不是判空字符串
  if (git(["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"], { capture: true, allowFail: true }) === null) {
    console.log("远端有新提交，先变基…");
    git(["rebase", "FETCH_HEAD"]);
  }
  // GitHub git HTTP 端点只认 basic：x-access-token:<token>；Bearer 会 401
  const token = process.env.GH_TOKEN || ghRaw(["auth", "token"], { capture: true, allowFail: true });
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
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

  // 3. 触发三平台 workflow
  const beforeJson = gh(
    ["run", "list", "--workflow", workflow, "--limit", "1", "--json", "databaseId"],
    { capture: true, allowFail: true },
  );
  const before = beforeJson ? JSON.parse(beforeJson)[0]?.databaseId ?? 0 : 0;
  const findNewRun = () => {
    const listJson = gh(
      ["run", "list", "--workflow", workflow, "--limit", "10", "--json", "databaseId,headBranch,event"],
      { capture: true, allowFail: true },
    );
    if (!listJson) return 0;
    return (
      JSON.parse(listJson).find((r) => r.headBranch === target && r.databaseId > before)?.databaseId ?? 0
    );
  };

  // push 本身可能已自动触发一次（release.yml 的 push main 规则）。两个 run 落在
  // 同一 concurrency group 会互相取消，所以先等自动 run 出现并复用它。
  console.log("检查 push 是否已自动触发构建…");
  for (let i = 0; i < 8; i++) {
    sleep(5000);
    runId = findNewRun();
    if (runId) {
      console.log(`复用 push 自动触发的 run ${runId}（不再手动触发）`);
      break;
    }
  }
  if (!runId) {
    gh(["workflow", "run", workflow, "--ref", target]);
    console.log("已手动触发三平台构建，等待 run 出现…");
    for (let i = 0; i < 30 && !runId; i++) {
      sleep(5000);
      runId = findNewRun();
    }
  }
  if (!runId) die("没找到新触发的 run，到 Actions 页面查看");
} else {
  console.log(`续传已有 run：${runId}`);
}

console.log(`run id：${runId}  https://github.com/${targetRepo}/actions/runs/${runId}`);

// 4. 等待三个 job 全部结束
const watched = gh(["run", "watch", String(runId), "--exit-status", "--interval", "20"], {
  allowFail: true,
});
if (watched === null) {
  console.error(`\n构建失败，查看日志：gh run view ${runId} --repo ${targetRepo} --log-failed\n`);
  const jobs = ghRaw(
    ["api", `repos/${targetRepo}/actions/runs/${runId}/jobs`, "--jq", '.jobs[] | .name + ": " + (.conclusion // "running")'],
    { capture: true, allowFail: true },
  );
  if (jobs) console.error(jobs);
  process.exit(1);
}

// 5. 下载全部 artifacts（windows / android / macos 各自一个目录）
gh(["run", "download", String(runId), "--dir", outDir]);

const files = readdirSync(outDir, { recursive: true })
  .map((f) => join(outDir, String(f)))
  .filter((p) => statSync(p).isFile());
if (!files.length) die(`下载完成但没有文件，检查 ${outDir}`);
console.log("\n完成，产物：");
for (const f of files) console.log(`  ${relative(process.cwd(), f)}`);
