# wrench

<img src="icon.png" width="80" height="80" alt="wrench" align="left">

Build and deploy CLI for static SPAs on AWS S3 + CloudFront, provisioned by
Terraform. Build, test, and deploy run through your project's own npm
scripts, so any toolchain works. It assumes a specific directory layout and
AWS account setup, both described below.

## Requirements

- Node (whatever version your project's `.nvmrc` says)
- [Terraform](https://developer.hashicorp.com/terraform/install)
- Python 3 with `boto3` (`pip install -r requirements.txt`)
- AWS credentials configured (`aws configure`, or the usual env vars)

## Install

Clone this repo as a **sibling directory** to any project that uses it. This
is required: every wrench-managed project's `infra/main.tf` points at the
shared Terraform module by relative path, `../../wrench/infra-module`. If
`wrench` isn't a sibling of your project directory, that path breaks.

```
projects/
  wrench/          <- this repo
  your-project/
  another-project/
```

Then:

```sh
cd wrench
npm link
```

`wrench` is now on your `$PATH` globally (true by default under nvm, as long
as your Node install's global bin dir is on `$PATH`).

Copy `wrench.config.example.json` to `wrench.config.json` (gitignored) and
fill in your own values:

```sh
cp wrench.config.example.json wrench.config.json
```

- `rootDomain`: the domain your sites are published under (e.g. a project
  deploys to `<subdomain>.<rootDomain>`).
- `registryBucket`: the S3 bucket holding the shared `manifest.json` that
  tracks every wrench-deployed project.

## How `wrench` decides what to do

Run `wrench` (with or without a subcommand) from inside any directory. It
picks one of three paths, in order:

1. **The directory has an executable `build.sh`.** wrench prints the
   resolved path and execs it, forwarding every argument you typed. This is
   the compatibility path for projects that predate wrench and still use the
   old copy-pasted `build.sh` + `infra/build_tools.py` convention. Nothing
   about the script's contents is inspected; it just runs.
2. **The directory has a `package.json`.** wrench runs its own pipeline. No
   prompt, no output about `build.sh`.
3. **Neither.** wrench exits 1 with usage.

A `build.sh` that exists but isn't a regular executable file is reported as
such rather than failing obscurely inside `spawn`.

## Setting up a new wrench-native project

A project is "wrench-native" once it has:

**`infra/main.tf`**, a thin wrapper around the shared module:

```hcl
terraform {
  required_version = ">= 1.5"
  required_providers {
    aws    = { source = "hashicorp/aws",    version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.0" }
  }
}

provider "aws" {
  region = var.aws_region
}

module "static_site" {
  source       = "../../wrench/infra-module"
  project_name = var.project_name
}
```

To publish under a custom domain, pass the domain variables through as well.
`subdomain` distinguishes three states that the shared registry uses to
decide this site's URL:

| `subdomain` | Meaning | Resulting URL |
|---|---|---|
| unset / `null` | no custom-domain wiring | the default `*.cloudfront.net` domain |
| `""` | the apex itself | `https://<root_domain>/` |
| `"app"` | a subdomain | `https://app.<root_domain>/` |

```hcl
module "static_site" {
  source         = "../../wrench/infra-module"
  project_name   = var.project_name
  subdomain      = "app"
  root_domain    = "example.com"
  hosted_zone_id = var.hosted_zone_id
}
```

The certificate is looked up by domain name, so `wrench/domain/` (a one-off
Terraform root that issues the wildcard ACM cert) never has to be touched
again once the cert is issued. That directory is gitignored, since it holds
a domain-specific cert; create your own if you need one.

**`infra/variables.tf`**:

```hcl
variable "project_name" {
  type    = string
  default = "your-project"
}

variable "aws_region" {
  type    = string
  default = "us-west-1"
}
```

**`infra/outputs.tf`**: re-export the module's outputs (the exact names
`wrench` reads via `terraform output`):

```hcl
output "bucket_name"                { value = module.static_site.bucket_name }
output "cloudfront_distribution_id" { value = module.static_site.cloudfront_distribution_id }
output "cloudfront_domain"          { value = module.static_site.cloudfront_domain }
```

**`version.json`** at the project root, the single source of truth for the
deployed version, bumped automatically by `wrench dev`/`wrench deploy`:

```json
{"major":0,"minor":0,"patch":0}
```

**`package.json`**: an optional `"wrench"` key for cosmetics on the promote
page, plus `dev`/`test`/`build` npm scripts wrench shells out to:

```json
{
  "scripts": {
    "dev": "vite",
    "test": "node --test 'src/tests/**/*.test.ts'",
    "build": "tsc --noEmit && vite build"
  },
  "wrench": {
    "displayName": "Your Project",
    "accentColor": "#569cd6",
    "distBudgetMb": 15,
    "subdomain": "app"
  }
}
```

`accentColor` must be a hex color and `subdomain` must be a string; wrench
rejects anything else rather than passing it through into the generated page.
`subdomain` here mirrors the Terraform variable above; omit it entirely if
the site has no custom domain.

Add `.wrench/` to the project's `.gitignore`. wrench writes `.wrench/build.log`
there during a deploy, deliberately outside `dist/`, which gets uploaded
wholesale.

Whatever builds `dist/` needs relative asset paths (e.g. Vite's
`base: './'`). The whole versioned-deploy scheme depends on the build
resolving identically whether it's served from the bucket root or nested
under `/versions/<version>/`.

Then, once:

```sh
wrench infra apply
```

And from then on:

```sh
wrench deploy
```

## Commands

| Command | What it does |
|---|---|
| `wrench` *(no subcommand)* | Same as `wrench deploy`: build and deploy in one step |
| `wrench dev` | Bump version, run tests (non-blocking), `npm run dev` |
| `wrench build [--clean]` | `npm run build`, verify `dist/index.html`, advisory dist-size budget check. `--clean` wipes `dist/` first |
| `wrench test` | `npm test` |
| `wrench deploy [--force] [--clean] [--version X.Y.Z]` | Bump version, build, `terraform apply` (idempotent), upload to S3, promote. `--version` sets `version.json` before building, so the build and the S3 prefix agree; `--force` replaces an already-uploaded version |
| `wrench infra plan\|apply\|output [args...]` | Run Terraform against `infra/` directly, without a full deploy |
| `wrench promote [version]` | Promote an already-uploaded version without rebuilding |
| `wrench list` | List every version currently in S3 |
| `wrench version [bump]` | Show or bump `version.json` |
| `wrench --version` / `-v` | wrench's own version |
| `wrench --help` / `-h` | Usage |

## How deploys work

Every deploy uploads the full `dist/` build to
`s3://<bucket>/versions/<semver>/`, immutable and content-hashed. Nothing
already-deployed is ever overwritten. "Promoting" a version writes a small
loading-overlay page (spinner + `<iframe src="/versions/<version>/index.html">`)
to the bucket root and fires a targeted CloudFront invalidation for
`/index.html` only. The root page is served `no-cache`; everything under
`versions/` is `immutable`.

A version prefix is either complete or absent: if an upload fails partway,
wrench deletes what it wrote before reporting the error, so a retry never has
to reach for `--force`. Promoting refuses a version that has no `index.html`,
so a half-uploaded build cannot become the live site. The bucket is versioned
with a 30-day window, which is what makes `--force` recoverable.

Rollback is re-promoting an older version, no rebuild, no re-upload:

```sh
wrench promote 1.2.3
```

## Repo layout

```
wrench/
├── bin/wrench.mjs          entrypoint: detection chain + subcommand dispatch
├── src/
│   ├── context.mjs         resolves a project root + "wrench" config from cwd
│   ├── lib/
│   │   ├── run.mjs          spawn wrapper, friendly errors for missing tools
│   │   ├── version-file.mjs read/bump/validate version.json, atomic writes
│   │   ├── deploy-env.mjs   terraform outputs -> the env build_tools reads
│   │   ├── detect.mjs       build.sh passthrough
│   │   └── errors.mjs       UserError: the errors that print without a stack
│   └── commands/            dev, build, test, deploy, infra, promote, list, version
├── python/
│   ├── build_tools.py      the S3 upload / promote engine (boto3)
│   └── tests/              unittest + moto
├── test/                   node --test
└── infra-module/           shared Terraform module (S3 + CloudFront + OAC)
```

## Development

```sh
npm test                                   # Node CLI

python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m unittest discover -s python -t python   # build_tools.py
```

The Python suite runs entirely against [moto](https://github.com/getmoto/moto);
it never touches a real AWS account. `WRENCH_DEBUG=1` makes `build_tools.py`
print a traceback instead of a one-line error.
