import { defineNuxtConfig } from 'nuxt3'
import MyModule from '..'

export default defineNuxtConfig({
  modules: [MyModule],

  gql: {
    documentPaths: []
  },

  publicRuntimeConfig: {
    GQL_HOST: 'https://api.spacex.land/graphql'
  }
})
