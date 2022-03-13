import defu from 'defu'
import { existsSync, statSync } from 'fs'
import {
  useLogger,
  addTemplate,
  resolveFiles,
  addAutoImport,
  addAutoImportDir,
  createResolver,
  defineNuxtModule,
} from '@nuxt/kit'
import generate from './generate'
import { name, version } from '../package.json'
import { prepareContext, GqlContext } from './context'
import { prepareOperations, prepareTemplate } from './utils'

const logger = useLogger('nuxt-graphql-client')

export interface GqlClient {
  host: string
  default?: boolean
  token?: string
}

export interface GqlConfig {
  clients: Record<string, string | GqlClient>
}

export interface GqlConfigReady {
  clients: Record<string, GqlClient>
}

export interface ModuleOptions {
  /**
   * Prevent codegen from printing to console in dev mode
   *
   * @type boolean
   * @default true
   */
  silent?: boolean

  /**
   * Enable hot reloading for GraphQL documents
   *
   * @type boolean
   * @default true
   */
  watch?: boolean

  /**
   * Auto import functions based on the operation names of your queries & mutations. When set to true, you can write
   * ```ts
   * const { launches } = await GqlLaunches()
   * ```
   * instead of
   * ```ts
   * const { launches } = await useGql().launches()
   * ```
   *
   * @type boolean
   * @default true
   */
  autoImport?: boolean

  /**
   * Prefix for auto imported functions
   *
   * @type string
   * @default 'Gql'
   */
  functionPrefix?: string

  /**
   * Path to folder(s) containing .gql or .graphql files. Can be omitted, module will automatically search for GraphQL Documents in the project's root directory.
   *
   * @note Useful for mono repos.
   *
   * @type string[]
   * @example ['../shared/queries']
   * */
  documentPaths?: string[]

  /**
   * Only generate the types for the operations in your GraphQL documents.
   * When set to true, only the types needed for your operations will be generated.
   * When set to false, all types from the GraphQL schema will be generated.
   *
   * @type boolean
   * @default true
   * */
  onlyOperationTypes?: boolean

  /**
   * Allows generating multiple clients with different GraphQL hosts.
   *
   * @note this option overrides the `GQL_HOST` in `publicRuntimeConfig`.
   * */
  clients?: GqlConfig['clients']
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name,
    version,
    configKey: 'gql',
    compatibility: {
      nuxt: '^3.0.0',
    },
  },
  defaults: {
    clients: {},
    watch: true,
    silent: true,
    autoImport: true,
    functionPrefix: 'Gql',
    onlyOperationTypes: true,
  },
  async setup(options, nuxt) {
    const ctx: GqlContext = {
      clients: [],
      clientOps: {},
    }

    const config: Partial<GqlConfig> = defu(
      {},
      nuxt.options.publicRuntimeConfig['graphql-client'],
      nuxt.options.publicRuntimeConfig['gql'],
      { clients: options.clients }
    )

    ctx.clients = Object.keys(config.clients)

    if (!ctx?.clients?.length) {
      const host =
        process.env.GQL_HOST || nuxt.options.publicRuntimeConfig.GQL_HOST

      if (!host) throw new Error('GQL_HOST is not set in publicRuntimeConfig')

      config.clients = { default: host }
    }

    const multipleClients = ctx?.clients?.length > 1

    if (multipleClients) {
      const defaults = Object.entries(config.clients).reduce((i, [k, v]) => {
        if (k === 'default' || (typeof v !== 'string' && v.default)) i++

        return i
      }, 0)

      if (defaults > 1)
        throw new Error('Only one client can have the default flag set.')
    }

    for (const [k, v] of Object.entries(config.clients)) {
      const runtimeHost =
        k === 'default'
          ? process.env.GQL_HOST
          : process.env?.[`GQL_${k.toUpperCase()}_HOST`]

      let host: string
      if (runtimeHost) host = runtimeHost
      else if (typeof v === 'string') host = v
      else if ('host' in v) host = v?.host

      if (!host) throw new Error(`GraphQL client (${k}) is missing it's host.`)

      const runtimeToken =
        k === 'default'
          ? process.env.GQL_TOKEN
          : process.env?.[`GQL_${k.toUpperCase()}_TOKEN`]

      let token = runtimeToken || (typeof v !== 'string' && v?.token)

      let conf = { host, ...(token && { token }) }

      ctx.clientOps[k] = []
      if (typeof v == 'string') config.clients[k] = conf
      else if ('host' in v) config.clients[k] = defu(v, conf)
    }

    // @ts-ignore
    nuxt.options.publicRuntimeConfig['graphql-client'] = config

    const resolver = createResolver(import.meta.url)
    const gqlResolver = createResolver(nuxt.options.srcDir)

    const documentPaths = [gqlResolver.resolve()]

    if (options.documentPaths) {
      for (const path of options.documentPaths) {
        const dir = createResolver(path).resolve()

        if (existsSync(dir)) documentPaths.push(dir)
        else logger.warn(`[Gql Module] Invalid document path: ${dir}`)
      }
    }

    const gqlMatch = '**/*.{gql,graphql}'
    async function generateGqlTypes() {
      const gqlFiles: string[] = []
      for await (const path of documentPaths) {
        const files = (await resolveFiles(path, gqlMatch)).filter(allowDocument)

        if (multipleClients) await prepareOperations(ctx, files)

        gqlFiles.push(...files)
      }

      const plugins = ['typescript']

      const documents = []

      if (gqlFiles?.length) {
        plugins.push('typescript-operations')

        for (const file of gqlFiles) {
          documents.push(file)
        }

        if (documents?.length) plugins.push('typescript-graphql-request')
      }

      ctx.template = await generate({
        clients: config.clients as GqlConfigReady['clients'],
        file: 'gql-sdk.ts',
        silent: options.silent,
        plugins,
        documents,
        onlyOperationTypes: options.onlyOperationTypes,
      })

      if (multipleClients) prepareTemplate(ctx)

      prepareContext(ctx, options.functionPrefix)
    }

    addTemplate({
      write: true,
      filename: `gql-sdk.ts`,
      getContents: () => ctx.template,
    })

    addAutoImport({
      as: 'gqlSdk',
      name: 'getSdk',
      from: `#build/gql-sdk`,
    })

    addAutoImportDir(resolver.resolve('runtime'))

    if (options.autoImport) {
      addTemplate({
        filename: 'gql.mjs',
        getContents: () => ctx.generateImports(),
      })

      addTemplate({
        filename: 'gql.d.ts',
        getContents: () => ctx.generateDeclarations(),
      })

      nuxt.hook('autoImports:extend', (autoimports) => {
        if (!ctx.fnImports?.length) return

        const names = autoimports.map((a) => a.name)

        const fnImports = ctx.fnImports.filter((i) => !names.includes(i.name))

        if (!fnImports?.length) return

        autoimports.push(...fnImports)
      })

      // TODO: See if needed
      // nuxt.hook('prepare:types', ({ references }) => {
      //   references.push({ path: 'gql.d.ts' })
      // })
    }

    const allowDocument = (f: string) => !!statSync(gqlResolver.resolve(f)).size

    if (options.watch) {
      nuxt.hook('builder:watch', async (event, path) => {
        if (!path.match(/\.(gql|graphql)$/)) return

        if (event !== 'unlink' && !allowDocument(path)) return

        const start = Date.now()
        await generateGqlTypes()
        await nuxt.callHook('builder:generateApp')

        const time = Date.now() - start
        logger.success(`[GraphQL Client]: Generation completed in ${time}ms`)
      })
    }

    await generateGqlTypes()
  },
})

declare module '@nuxt/schema' {
  interface PublicRuntimeConfig {
    /**
     * URL pointing to a GraphQL endpoint
     *
     * @type string
     */
    GQL_HOST: string

    // @ts-ignore
    gql?: GqlConfig

    // @ts-ignore
    'graphql-client'?: GqlConfig
  }
}
