import { CliUsageError } from './cli-shared.js';
import {
  parseCliTokens,
  type ControlCliDependencies,
} from './control-cli.js';
import {
  createClient,
  readTemplate,
  reportCliError,
  requirePositionals,
  requirePositionalsValue,
  writeJson,
} from './live-cli-shared.js';

const TEMPLATE_USAGE =
  'usage: wax template <compose <template.json>|list> [--daemon-dir <dir>] [--json]';

/** `wax template compose|list`: one daemon, one token, no live created. */
export async function runTemplateCli(
  argv: readonly string[],
  deps: ControlCliDependencies = {},
): Promise<number> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    const parsed = parseCliTokens(argv.slice(2), new Set(['--daemon-dir']));
    const client = createClient(parsed, deps);
    if (argv[1] === 'list') {
      requirePositionals(parsed, 0, TEMPLATE_USAGE);
      const templates = await client.listTemplates();
      if (parsed.json) {
        writeJson(out, { templates });
      } else {
        for (const template of templates) {
          out(String((template as Record<string, unknown>)['templateId']));
        }
      }
      return 0;
    }
    if (argv[1] !== 'compose') {
      throw new CliUsageError(TEMPLATE_USAGE);
    }
    requirePositionals(parsed, 1, TEMPLATE_USAGE);
    const templateId = await client.composeTemplate(
      readTemplate(requirePositionalsValue(parsed)),
    );
    if (parsed.json) {
      writeJson(out, { templateId });
    } else {
      out(`composed ${templateId}`);
    }
    return 0;
  } catch (error) {
    return reportCliError(error, err);
  }
}
