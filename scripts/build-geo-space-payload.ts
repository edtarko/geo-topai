import path from "node:path";
import {
  buildGeoSpaceBundle,
  writeGeoSpaceBundleFiles,
} from "../geo-space.ts";

type CliArgs = {
  dbPath: string;
  outDir: string;
  maxProjects: number;
  maxPeople: number;
  personCsvPath: string;
  paperCsvPath: string;
  projectCsvPath: string;
  writeSheetCsv: boolean;
  writeDemoLayout: boolean;
  help: boolean;
};

function readOption(argv: string[], key: string) {
  const direct = argv.find((arg) => arg.startsWith(`--${key}=`));
  if (direct) return direct.slice(key.length + 3);

  const index = argv.findIndex((arg) => arg === `--${key}`);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];

  return "";
}

function toInt(value: string, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.floor(numeric);
}

function parseArgs(argv: string[]): CliArgs {
  const help = argv.includes("--help") || argv.includes("-h");
  return {
    dbPath: readOption(argv, "db") || "geo.db",
    outDir: readOption(argv, "out") || "geo_space_payload",
    maxProjects: toInt(readOption(argv, "max-projects"), 1000),
    maxPeople: toInt(readOption(argv, "max-people"), 2000),
    personCsvPath: readOption(argv, "person-csv") || "Person.csv",
    paperCsvPath: readOption(argv, "paper-csv") || "Paper.csv",
    projectCsvPath: readOption(argv, "project-csv") || "Projects.csv",
    writeSheetCsv: readOption(argv, "write-sheet-csv") === "0" ? false : true,
    writeDemoLayout: readOption(argv, "write-demo-layout") === "0" ? false : true,
    help,
  };
}

function printHelp() {
  console.log(`Geo Space payload builder\n
Usage:
  npm run geo:payload -- [options]

Options:
  --db <path>             Path to SQLite DB (default: geo.db)
  --out <dir>             Output directory (default: geo_space_payload)
  --max-projects <n>      Max projects to export (default: 1000)
  --max-people <n>        Max people to export (default: 2000)
  --person-csv <path>     Optional Person CSV source (default: Person.csv)
  --paper-csv <path>      Optional Paper CSV source (default: Paper.csv)
  --project-csv <path>    Optional Projects CSV overrides (default: Projects.csv)
  --write-sheet-csv 0|1   Write Person.csv/Paper.csv/Projects.csv into output (default: 1)
  --write-demo-layout 0|1 Write data_to_publish + editable folders (default: 1)
  --help                  Show this help
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const bundle = buildGeoSpaceBundle({
    dbPath: args.dbPath,
    maxProjects: args.maxProjects,
    maxPeople: args.maxPeople,
    personCsvPath: args.personCsvPath,
    paperCsvPath: args.paperCsvPath,
    projectCsvPath: args.projectCsvPath,
  });

  const outDir = path.resolve(process.cwd(), args.outDir);
  const files = writeGeoSpaceBundleFiles(bundle, {
    outDir,
    writeSheetCsv: args.writeSheetCsv,
    writeDemoLayout: args.writeDemoLayout,
  });

  console.log("[geo-space] Payload generated.");
  console.log(`- projects: ${bundle.meta.counts.projects}`);
  console.log(`- people: ${bundle.meta.counts.people}`);
  console.log(`- topics: ${bundle.meta.counts.topics}`);
  console.log(`- papers: ${bundle.meta.counts.papers}`);
  console.log(`[geo-space] Output: ${outDir}`);
  for (const [key, filePath] of Object.entries(files)) {
    console.log(`  - ${key}: ${filePath}`);
  }
}

main();
