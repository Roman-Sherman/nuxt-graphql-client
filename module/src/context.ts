import { promises as fsp } from 'fs'
import { parse } from 'graphql'
import { upperFirst } from 'scule'
import type { Import } from 'unimport'

export interface GqlContext {
  template?: string
  fns?: string[]
  clients?: string[]
  fnImports?: Import[]
  generateImports?: () => string
  generateDeclarations?: () => string
  clientOps?: Record<string, string[]> | null
}

export function prepareContext (ctx: GqlContext, prefix: string) {
  ctx.fns = ctx.template?.match(/\w+\s*(?=\(variables)/g)?.sort() || []

  const fnName = (fn: string) => prefix + upperFirst(fn)

  const fnExp = (fn: string, typed = false) => {
    const name = fnName(fn)

    if (!typed) {
      const client = ctx?.clients.find(c => ctx?.clientOps?.[c]?.includes(fn))

      if (!client) { return `export const ${name} = (...params) => useGql()['${fn}'](...params)` } else { return `export const ${name} = (...params) => useGql('${client}')['${fn}'](...params)` }
    }

    return `  export const ${name}: (...params: Parameters<GqlFunc['${fn}']>) => ReturnType<GqlFunc['${fn}']>`
  }

  ctx.generateImports = () => {
    return [
      'import { useGql } from \'#imports\'',
      ...ctx.fns.map(f => fnExp(f))
    ].join('\n')
  }

  ctx.generateDeclarations = () => {
    return [
      'declare module \'#build/gql\' {',
      `  type GqlClients = '${ctx.clients.join("' | '")}'`,
      '  type GqlFunc = ReturnType<typeof import(\'#imports\')[\'useGql\']>',
      ...ctx.fns.map(f => fnExp(f, true)),
      '}'
    ].join('\n')
  }

  ctx.fnImports = ctx.fns.map((fn) => {
    const name = fnName(fn)

    return {
      name,
      as: name,
      from: '#build/gql'
    }
  })
}

export async function prepareOperations (ctx: GqlContext, path: string[]) {
  const scanFile = async (file: string) => {
    let clientToUse: string | undefined

    const reExt = new RegExp(`\\.(${ctx.clients.join('|')})\\.(gql|graphql)$`)
    if (reExt.test(file)) { clientToUse = reExt.exec(file)?.[1] }

    const fileName = file.split('/').pop().replace(/\./g, '\\.')
    const reDir = new RegExp(`\\/(${ctx.clients.join('|')})\\/(?=${fileName})`)

    if (!clientToUse && reDir.test(file)) { clientToUse = reDir.exec(file)?.[1] }

    const { definitions } = parse(await fsp.readFile(file, 'utf8'))

    // @ts-ignore
    const operations: string[] = definitions.map(({ name }) => {
      if (!name?.value) { throw new Error(`Operation name missing in: ${file}`) }

      return name.value
    })

    for (const op of operations) {
      const clientName = new RegExp(`^(${ctx.clients.join('|')}[^_]*)`).exec(op)?.[0]

      if (!clientName || !ctx.clientOps?.[clientName]) {
        if (clientToUse && !ctx.clientOps?.[clientToUse]?.includes(op)) {
          ctx.clientOps[clientToUse].push(op)
        }

        continue
      }

      const operationName = op.replace(`${clientName}_`, '')
      if (!ctx.clientOps?.[clientName]?.includes(operationName)) {
        ctx.clientOps[clientName].push(operationName)
      }
    }
  }

  for (const file of path) { await scanFile(file) }
}

export function prepareTemplate (ctx: GqlContext) {
  for (const [client, ops] of Object.entries(ctx.clientOps)) {
    if (!ops?.length) { continue }

    for (const op of ops) {
      const originalName = `${client}_${op}`
      const originalNameRe = new RegExp(originalName, 'g')

      const toPSCase = (s: string) => s.split('_').map(upperFirst).join('_')

      const secondCase = toPSCase(originalName)
      const secondCaseRe = new RegExp(secondCase, 'g')
      const secondResult = toPSCase(op)

      ctx.template = ctx.template
        .replace(originalNameRe, op)
        .replace(secondCaseRe, secondResult)
    }
  }
}
