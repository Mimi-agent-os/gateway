# mimi-gateway

[![CI](https://github.com/Mimi-agent-os/gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/Mimi-agent-os/gateway/actions/workflows/ci.yml)

mimi-os runs your own AI agents on your own machines, and you talk to them from a desktop or Android app.
This repo is the gateway, the always-on daemon between the app, the agents and the models; each agent carries its own logic.
It runs the model calls, keeps the provider keys and spending limits, asks your approval before a tool that writes, and calls each agent's tools.

Requires Node.js 24 or newer and pnpm.

The gateway admits agents and paired devices and keeps their permissions and model grants; the app and every agent
reach it over one encrypted channel on port 46464. The `server` and `devkit` profiles of launch clone it: on a server
pm2 runs `dist/daemon.js`, on your own machine `mimi start` runs it in the background, and devkit's `mimi-dev` starts
a separate one for testing an agent. launch also writes `~/.local/bin/mimi`, a small script that runs this
workspace's `mimi` CLI, so `mimi` works from any directory.

## Scripts

```sh
pnpm build   # delete dist/, then tsc -p tsconfig.build.json
pnpm check   # tsc type check
pnpm test    # node --test "test/**/*.test.ts"; needs protocol and sdk built next to it
pnpm start   # node dist/daemon.js in the foreground
```

## The mimi CLI

```sh
mimi run                          # the gateway in the foreground
mimi start                        # start it in the background and wait until it answers
mimi stop                         # stop the gateway mimi start started
mimi restart                      # stop, then start
mimi status                       # pid, state folder, listeners, addresses the app can dial (the default command)
mimi logs [n] [-f]                # the last n lines of gateway.log (default 60); -f follows
mimi pair [--address <url>]       # a one-time pairing link for the app
mimi invite <agent> [--write <.env>] [--address <url>]   # MIMI_INVITE and MIMI_GATEWAY_URL for an agent
mimi block <agent>                # kill switch: end the agent's sessions and refuse new ones
mimi unblock <agent>              # let it connect again; grant its permissions anew in the app
mimi public-url [<url> | --clear] # show, set or remove MIMI_PUBLIC_URL in $MIMI_HOME/.env
```

Every command also takes `--host <ip>` (default `127.0.0.1`), `--port <n>` (default `46464`) and
`--lan <host>`, a second listener for other machines that carries the encrypted channel (`0.0.0.0`: every interface);
the local API stays on the loopback listener.

## Pairing

`mimi pair` on the gateway host prints a `mimi://pair/v2?…` link for the app's connect screen, valid for one use
within 2 minutes. The link carries the address to dial: `MIMI_PUBLIC_URL`, else the Tailscale address, else the LAN
one (both come from `--lan`), else loopback, for an app on the same machine.
For an agent, `mimi invite <agent> --write agents/<agent>/.env` gives an invite valid for one use within 24 hours;
then grant its permissions in the app. An agent sends its avatar when it connects; the gateway checks it and shows it in the app.

## Models and limits

Models are added in the app: a local server (vLLM, llama.cpp) or OpenRouter. An agent uses the models granted to
it in the app, and the default model until it has a grant. The model that runs is the one a call names, else the
primary set for that agent in the app, else the one in the agent's code (`runAgent({ model })`), else the default.
Moving an agent between a local and a cloud model is a setting in the app.

Prices (dollars per 1M tokens) and daily limits (tokens or dollars) are set per model in the app under Settings,
Limits & prices. A limit caps one model for all agents per day in `MIMI_TZ` and resets at midnight; past it, the
call goes to the agent's fallback model when one is set, and is refused otherwise.

## Approvals and questions

A tool the agent marks as writing waits for your approval in the app, which shows its exact arguments; in a run
started outside the app, such as a request from another agent, the call is denied. The built-in `ask_owner` tool lets
an agent ask you 1 to 4 questions with 2 to 8 options each (several picks or a free answer allowed) and waits the
same way. When you dismiss the questions, leave them for 12 hours, or they come in a run started outside the app, the
agent is told you did not answer and carries on.

## Phone push

When something waits on you (a tool call to approve, a question, a finished chat reply, an Inbox item, a new device
to approve), each paired phone that registered for push and whose app is disconnected from the gateway at that
moment gets a Firebase Cloud Messaging notification, at most one per 30 s. Its text is fixed: "mimi" and
"Something needs you. Open the app for more." Setting `FCM_SERVICE_ACCOUNT_KEY` turns push on.

## Settings

Read from `$MIMI_HOME/.env` (dotenvx; keys saved from the app are encrypted); the real environment wins.

| Name | Meaning |
| --- | --- |
| `MIMI_TZ` | your IANA time zone (`America/New_York`), default the host's; every "today" is a day in it; the gateway checks it at boot and stops on an invalid name |
| `MIMI_PUBLIC_URL` | the address the app dials from other networks (`https://mimi.example.com:8443`): a domain, a reverse proxy or a forwarded port, given as an http(s) URL and checked at boot like `MIMI_TZ`. A proxy on this host must set `X-Real-IP` to its client's address (nginx: `proxy_set_header X-Real-IP $remote_addr`): the per-address handshake limit counts a proxied client under that header |
| `OPENROUTER_API_KEY` | the key every `openrouter` model shares |
| `VLLM_API_KEY` | an optional key every `vllm` model shares |
| `FCM_SERVICE_ACCOUNT_KEY` | the Firebase service account JSON key, on one line in single quotes (`'{"project_id":…}'`); it turns phone push on and is checked at boot like `MIMI_TZ` |
| `<MODEL>_API_KEY` | one model's own key (its name upper-cased, other characters as `_`); wins over the shared one |
| `MIMI_HOME` | set in the environment: the state folder, default `mimi/` next to this package, whatever the current directory |
| `MIMI_DEV_UI` | set in the environment, for app development: the loopback address of the app's dev server, which agent interfaces (mini-apps) also accept |

## State

`$MIMI_HOME` (0700; `gateway/mimi/` in a workspace) holds `gateway.db` (SQLite: models, usage, admitted agents with
their keys and permissions, devices and their push tokens, the Inbox), `.env`, `.env.keys`, `.channel.key` (the
gateway's channel identity), `.local-token` (the CLI's loopback secret, new at every boot), and `gateway.pid` and
`gateway.log` when `mimi start` ran it. Secrets are 0600. `mimi-launch reset` backs up the state files, then deletes
them, keeping `.env` and `.env.keys`.

## See also

[launch](https://github.com/Mimi-agent-os/launch) (setup) · [protocol](https://github.com/Mimi-agent-os/protocol) ·
[sdk](https://github.com/Mimi-agent-os/sdk) (writing an agent; also in the [wiki](https://mimi-agent-os.github.io/wiki/#/sdk)) ·
[app](https://github.com/Mimi-agent-os/app) · [devkit](https://github.com/Mimi-agent-os/devkit)

Licensed under Apache-2.0, see LICENSE.
