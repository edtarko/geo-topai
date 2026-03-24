import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const DEFAULT_SPACE_REGISTRY = "0xB01683b2f0d38d43fcD4D9aAB980166988924132";

const SpaceRegistryAbi = [
  {
    type: "function",
    name: "addressToSpaceId",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "bytes16" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "spaceIdToAddress",
    inputs: [{ name: "_spaceId", type: "bytes16" }],
    outputs: [{ name: "_account", type: "address" }],
    stateMutability: "view",
  },
];

function readOption(argv, key, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`--${key}=`));
  if (inline) return inline.slice(key.length + 3);
  const index = argv.findIndex((arg) => arg === `--${key}`);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  return fallback;
}

function toInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function normalizeSpaceId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^0x[0-9a-fA-F]{32}$/i.test(raw)) return raw.slice(2).toLowerCase();
  if (/^[0-9a-fA-F]{32}$/i.test(raw)) return raw.toLowerCase();
  return "";
}

function toSpaceIdHex(spaceId) {
  const normalized = normalizeSpaceId(spaceId);
  if (!normalized) return "";
  return `0x${normalized}`;
}

function normalizePrivateKey(value) {
  const raw = String(value || "").trim().replace(/^"|"$/g, "");
  if (!raw) return "";
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return "";
  return key;
}

function privateKeyHint(value) {
  const raw = String(value || "").trim().replace(/^0x/i, "");
  if (!raw) return "empty";
  const hexOnly = /^[0-9a-fA-F]+$/.test(raw);
  return `len=${raw.length},hex=${hexOnly ? "yes" : "no"}`;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function loadJsonArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return Array.isArray(payload) ? payload : [];
  } catch {
    return [];
  }
}

function summarizeEntity(item, kind) {
  if (!item || typeof item !== "object") return "";
  const lines = [];
  if (item.description) lines.push(String(item.description).trim());

  if (kind === "topics") {
    if (item.slug) lines.push(`Slug: ${item.slug}`);
    if (Number.isFinite(item.usage_count)) lines.push(`Usage count: ${item.usage_count}`);
  }

  if (kind === "people") {
    if (item.role) lines.push(`Role: ${item.role}`);
    if (item.works_at) lines.push(`Works at: ${item.works_at}`);
    if (item.x) lines.push(`X: ${item.x}`);
    if (item.web_url) lines.push(`Website: ${item.web_url}`);
    if (item.links?.scholar) lines.push(`Scholar: ${item.links.scholar}`);
  }

  if (kind === "projects") {
    if (item.web_url) lines.push(`Repository: ${item.web_url}`);
    if (item.organization?.name) lines.push(`Organization: ${item.organization.name}`);
    if (item.stats?.stars !== undefined) lines.push(`Stars: ${item.stats.stars}`);
    if (item.stats?.language) lines.push(`Language: ${item.stats.language}`);
    if (Array.isArray(item.topics) && item.topics.length) lines.push(`Topics: ${item.topics.join(", ")}`);
  }

  if (kind === "papers") {
    if (item.author) lines.push(`Author: ${item.author}`);
    if (item.publish_date) lines.push(`Publish date: ${item.publish_date}`);
    if (item.web_url) lines.push(`URL: ${item.web_url}`);
  }

  return lines.filter(Boolean).join("\n");
}

function printHelp() {
  console.log(`Publish GEO draft payload\n
Usage:
  npm run geo:publish -- [options]

Options:
  --payload-dir <dir>     Folder containing topics.json/people.json/projects.json/papers.json
                          (default: geo_space_payload/data_to_publish)
  --network <name>        SDK network name (default: TESTNET)
  --private-key <hex>     Private key (or GEO_PRIVATE_KEY from .env)
  --space-id <id>         Existing space id (16-byte hex, with or without 0x)
  --registry <address>    Space registry address override
  --batch-size <n>        Entities per publish edit (default: 20)
  --max-per-kind <n>      Max entities per kind per run (default: 100)
  --offline 1             Validate payload and build edit ops without any network calls
  --skip-rpc-check 1      Skip chain/RPC ownership checks (dry-run only)
  --publish 1             Actually send transactions (default: dry-run)
  --include-papers 1      Include papers.json as entities (default: 0)
  --help                  Show this help
\nDry-run default: it prepares CIDs/edits but does not broadcast tx unless --publish 1 is set.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const payloadDir = path.resolve(process.cwd(), readOption(argv, "payload-dir", "geo_space_payload/data_to_publish"));
  const network = readOption(argv, "network", process.env.GEO_NETWORK || "TESTNET").toUpperCase();
  const privateKeyInput = readOption(argv, "private-key", process.env.GEO_PRIVATE_KEY || "").trim();
  const privateKey = normalizePrivateKey(privateKeyInput);
  const spaceIdInput = readOption(argv, "space-id", process.env.GEO_SPACE_ID || "");
  const registryAddress = readOption(argv, "registry", process.env.GEO_SPACE_REGISTRY || DEFAULT_SPACE_REGISTRY);
  const batchSize = toInt(readOption(argv, "batch-size", "20"), 20);
  const maxPerKind = toInt(readOption(argv, "max-per-kind", "100"), 100);
  const offline = readOption(argv, "offline", "0") === "1";
  const skipRpcCheck = readOption(argv, "skip-rpc-check", "0") === "1";
  const shouldPublish = readOption(argv, "publish", "0") === "1";
  const includePapers = readOption(argv, "include-papers", "0") === "1";

  let sdk;
  try {
    sdk = await import("@geoprotocol/geo-sdk");
  } catch (error) {
    throw new Error(
      `Geo SDK dependencies are not installed. Run: npm install @geoprotocol/geo-sdk viem ox\n${error}`,
    );
  }

  const topics = loadJsonArray(path.join(payloadDir, "topics.json")).slice(0, maxPerKind);
  const people = loadJsonArray(path.join(payloadDir, "people.json")).slice(0, maxPerKind);
  const projects = loadJsonArray(path.join(payloadDir, "projects.json")).slice(0, maxPerKind);
  const papers = includePapers ? loadJsonArray(path.join(payloadDir, "papers.json")).slice(0, maxPerKind) : [];

  if (!topics.length && !people.length && !projects.length && !papers.length) {
    throw new Error(`No payload data found in ${payloadDir}`);
  }

  const groups = [
    { kind: "topics", items: topics },
    { kind: "people", items: people },
    { kind: "projects", items: projects },
    { kind: "papers", items: papers },
  ].filter((group) => group.items.length);

  const { Graph, IdUtils } = sdk;

  if (offline) {
    console.log("[geo-publish] Mode: offline");
    console.log(`[geo-publish] Payload: ${payloadDir}`);
    for (const group of groups) {
      const chunks = chunkArray(group.items, batchSize);
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        const ops = [];

        for (const item of chunk) {
          const id = IdUtils.generate();
          const name = String(item.name || `${group.kind}-${id}`).slice(0, 256);
          const sourceId = item?.id ? `Source ID: ${item.id}` : "";
          const description = [summarizeEntity(item, group.kind), sourceId]
            .filter(Boolean)
            .join("\n")
            .slice(0, 4000);

          const result = Graph.createEntity({
            id,
            name,
            description,
            types: [],
            values: [],
          });
          ops.push(...result.ops);
        }

        const editName = `Geo AI ${group.kind} batch ${index + 1}/${chunks.length}`;
        console.log(`[geo-publish] ${editName} [offline]`);
        console.log(`  entities: ${chunk.length}`);
        console.log(`  ops: ${ops.length}`);
      }
    }
    console.log("[geo-publish] Offline validation completed.");
    return;
  }

  if (shouldPublish && skipRpcCheck) {
    throw new Error("`--skip-rpc-check 1` cannot be used with `--publish 1`.");
  }

  if (!privateKey && !skipRpcCheck) {
    throw new Error(
      `Missing/invalid private key. Set GEO_PRIVATE_KEY in .env or pass --private-key (64-hex, with or without 0x). [${privateKeyHint(privateKeyInput)}]`,
    );
  }

  const { personalSpace, getWalletClient } = sdk;
  let walletClient = null;
  let accountAddress = "";
  let spaceId = normalizeSpaceId(spaceIdInput);

  if (skipRpcCheck) {
    if (!spaceId) {
      throw new Error("Missing/invalid space ID for skip-rpc-check mode. Set GEO_SPACE_ID or pass --space-id.");
    }
    accountAddress = "n/a (skip-rpc-check)";
  } else {
    let viem;
    try {
      viem = await import("viem");
    } catch (error) {
      throw new Error(`Missing viem dependency. Run: npm install viem\n${error}`);
    }

    walletClient = await getWalletClient({ privateKey });
    const account = walletClient.account;
    if (!account?.address) throw new Error("Failed to initialize wallet account from private key.");
    accountAddress = account.address;

    const { createPublicClient, http } = viem;
    const rpcUrl = walletClient.chain?.rpcUrls?.default?.http?.[0];
    if (!rpcUrl) throw new Error("Unable to resolve RPC URL from wallet client.");

    const publicClient = createPublicClient({ transport: http(rpcUrl) });

    if (!spaceId) {
      let spaceIdHex = await publicClient.readContract({
        address: registryAddress,
        abi: SpaceRegistryAbi,
        functionName: "addressToSpaceId",
        args: [account.address],
      });

      const ZERO_ID = "0x00000000000000000000000000000000";
      if (spaceIdHex === ZERO_ID) {
        const { to, calldata } = personalSpace.createSpace();
        if (shouldPublish) {
          const txHash = await walletClient.sendTransaction({ account, to, data: calldata });
          await publicClient.waitForTransactionReceipt({ hash: txHash });
        } else {
          console.log("[dry-run] Space does not exist; createSpace tx prepared but not sent.");
        }

        spaceIdHex = await publicClient.readContract({
          address: registryAddress,
          abi: SpaceRegistryAbi,
          functionName: "addressToSpaceId",
          args: [account.address],
        });
      }

      if (spaceIdHex === ZERO_ID) {
        throw new Error("No spaceId found. Run with --publish 1 once to register your Personal Space.");
      }

      spaceId = String(spaceIdHex).slice(2, 34).toLowerCase();
    }

    const spaceOwner = await publicClient.readContract({
      address: registryAddress,
      abi: SpaceRegistryAbi,
      functionName: "spaceIdToAddress",
      args: [toSpaceIdHex(spaceId)],
    });

    if (String(spaceOwner || "").toLowerCase() !== String(account.address).toLowerCase()) {
      throw new Error(
        `Space ownership mismatch. Wallet ${account.address} is not owner of space ${spaceId} (owner: ${spaceOwner}). Use the correct wallet/private key for this space.`,
      );
    }
  }

  console.log(`[geo-publish] Account: ${accountAddress}`);
  console.log(`[geo-publish] Space ID: ${spaceId}`);
  console.log(`[geo-publish] Network: ${network}`);
  console.log(`[geo-publish] Mode: ${shouldPublish ? "publish" : "dry-run"}${skipRpcCheck ? " (skip-rpc-check)" : ""}`);

  for (const group of groups) {
    const chunks = chunkArray(group.items, batchSize);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const ops = [];

      for (const item of chunk) {
        // GEO entities require protocol-native IDs; generate fresh IDs for publish batches.
        const id = IdUtils.generate();
        const name = String(item.name || `${group.kind}-${id}`).slice(0, 256);
        const sourceId = item?.id ? `Source ID: ${item.id}` : "";
        const description = [summarizeEntity(item, group.kind), sourceId]
          .filter(Boolean)
          .join("\n")
          .slice(0, 4000);

        const result = Graph.createEntity({
          id,
          name,
          description,
          types: [],
          values: [],
        });
        ops.push(...result.ops);
      }

      const editName = `Geo AI ${group.kind} batch ${index + 1}/${chunks.length}`;
      const { cid, editId, to, calldata } = await personalSpace.publishEdit({
        name: editName,
        spaceId,
        ops,
        author: spaceId,
        network,
      });

      console.log(`[geo-publish] ${editName}`);
      console.log(`  cid: ${cid}`);
      console.log(`  editId: ${editId}`);

      if (!shouldPublish) {
        console.log("  tx: [dry-run skipped]");
        continue;
      }

      if (!walletClient || !walletClient.account) {
        throw new Error("Wallet client unavailable for publish mode.");
      }
      const txHash = await walletClient.sendTransaction({ account: walletClient.account, to, data: calldata });
      console.log(`  tx: ${txHash}`);
    }
  }

  console.log("[geo-publish] Done.");
}

main().catch((error) => {
  console.error("[geo-publish] Failed:", error?.message || error);
  process.exit(1);
});
