import type { FieldSymbol, ModelSymbol, PslSpan, ResolvedAttribute } from '@internal/psl-parser';
import {
  type DiagnosticSource,
  type PslDiagnosticCollector,
  parseQuotedStringLiteral,
} from '@internal/psl-parser';
import type {
  ExpressionAst,
  FieldAttributeAst,
  ModelAttributeAst,
} from '@internal/psl-parser/syntax';
import { StringLiteralExprAst } from '@internal/psl-parser/syntax';
import { defaultTableName } from './default-table-name';

export { parseQuotedStringLiteral };

function mappedName(attributes: readonly ResolvedAttribute[] | undefined): string | undefined {
  const args = getAttribute(attributes, 'map')?.args;
  const argument = args?.length === 1 ? args[0] : undefined;
  const expression = argument?.kind === 'positional' ? argument.expression : undefined;
  return expression instanceof StringLiteralExprAst ? expression.value() || undefined : undefined;
}

export function modelStorageName(model: ModelSymbol): string {
  return mappedName(model.attributes) ?? defaultTableName(model.name);
}

export function fieldStorageName(field: FieldSymbol): string {
  return mappedName(field.attributes) ?? field.name;
}

export function getAttribute<TNode extends FieldAttributeAst | ModelAttributeAst>(
  attributes: readonly ResolvedAttribute<TNode>[] | undefined,
  name: string,
): ResolvedAttribute<TNode> | undefined {
  return attributes?.find((attribute) => attribute.name === name);
}

export function formatDbAttributeMigrationMessage(attribute: ResolvedAttribute): string {
  const renderedArguments = attribute.args
    .map((argument) =>
      argument.kind === 'named' && argument.name !== undefined
        ? `${argument.name}: ${argument.value}`
        : argument.value,
    )
    .join(', ');
  const argumentList = attribute.args.length === 0 ? '' : `(${renderedArguments})`;
  const constructorName = attribute.name.slice('db.'.length);

  return `@${attribute.name}${argumentList} is no longer supported; use ${constructorName}${argumentList} in type position`;
}

export function getNamedArgument(attribute: ResolvedAttribute, name: string): string | undefined {
  const entry = attribute.args.find((arg) => arg.kind === 'named' && arg.name === name);
  if (entry?.kind !== 'named') {
    return undefined;
  }
  return entry.value;
}

export function getPositionalArgumentEntry(
  attribute: ResolvedAttribute,
  index = 0,
): { value: string; expression?: ExpressionAst; span: PslSpan } | undefined {
  const entries = attribute.args.filter((arg) => arg.kind === 'positional');
  const entry = entries[index];
  if (entry?.kind !== 'positional') {
    return undefined;
  }
  return {
    value: entry.value,
    ...(entry.expression !== undefined ? { expression: entry.expression } : {}),
    span: entry.span,
  };
}

export function mapFieldNamesToColumns(input: {
  readonly model: ModelSymbol;
  readonly fieldNames: readonly string[];
  readonly source: DiagnosticSource;
  readonly diagnostics: PslDiagnosticCollector;
  readonly span: PslSpan;
  readonly entityLabel: string;
}): readonly string[] | undefined {
  const columns: string[] = [];
  for (const fieldName of input.fieldNames) {
    const field = input.model.fields[fieldName];
    if (field === undefined) {
      input.diagnostics.push({
        code: 'PSL_INVALID_ATTRIBUTE_ARGUMENT',
        message: `${input.entityLabel} references unknown field "${input.model.name}.${fieldName}"`,
        ...input.source.at(input.span),
      });
      return undefined;
    }
    columns.push(fieldStorageName(field));
  }
  return columns;
}
