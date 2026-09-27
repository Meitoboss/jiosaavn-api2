import { OpenAPIHono } from '@hono/zod-openapi'
import { apiReference } from '@scalar/hono-api-reference'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { prettyJSON } from 'hono/pretty-json'
import { Home } from './pages/home'
import type { Routes } from '#common/types'
import type { HTTPException } from 'hono/http-exception'

// JioSaavn の不揃いなデータ構造を安全な値に補正する関数
function sanitizeItem(item: any): any {
  if (!item || typeof item !== 'object') return {}

  // JioSaavn が image: false などで返してくる場合にアプリが .replace() で落ちるのを防ぐ
  if (typeof item.image !== 'string') item.image = ''
  if (typeof item.title !== 'string') item.title = item.song || item.name || ''
  if (typeof item.song !== 'string') item.song = item.title || ''
  if (typeof item.subtitle !== 'string') item.subtitle = ''
  if (typeof item.type !== 'string') item.type = 'song'
  if (typeof item.perma_url !== 'string') item.perma_url = ''

  if (!item.more_info || typeof item.more_info !== 'object') {
    item.more_info = {}
  }

  const m = item.more_info
  if (typeof m.singers !== 'string') m.singers = ''
  if (typeof m.music !== 'string') m.music = ''
  if (typeof m.album !== 'string') m.album = ''
  if (typeof m.primary_artists !== 'string') m.primary_artists = ''
  if (typeof m.encrypted_media_url !== 'string') m.encrypted_media_url = ''

  if (!m.artistMap || typeof m.artistMap !== 'object') {
    m.artistMap = { primary_artists: [], featured_artists: [], artists: [] }
  } else {
    if (!Array.isArray(m.artistMap.primary_artists)) m.artistMap.primary_artists = []
    if (!Array.isArray(m.artistMap.featured_artists)) m.artistMap.featured_artists = []
    if (!Array.isArray(m.artistMap.artists)) m.artistMap.artists = []
  }

  return item
}

function sanitizeJioSaavnData(data: any): any {
  if (!data || typeof data !== 'object') {
    data = {}
  }

  if (Array.isArray(data)) {
    return data.map(sanitizeItem)
  }

  if (!Array.isArray(data.results)) {
    data.results = []
  } else {
    data.results = data.results.map(sanitizeItem)
  }

  const categories = ['songs', 'albums', 'artists', 'playlists', 'topquery', 'shows']
  for (const cat of categories) {
    if (!data[cat] || typeof data[cat] !== 'object') {
      data[cat] = { data: [] }
    } else if (!Array.isArray(data[cat].data)) {
      data[cat].data = []
    } else {
      data[cat].data = data[cat].data.map(sanitizeItem)
    }
  }

  return data
}

export class App {
  private app: OpenAPIHono

  constructor(routes: Routes[]) {
    this.app = new OpenAPIHono()

    this.initializeGlobalMiddlewares()
    this.initializeRoutes(routes)
    this.initializeSwaggerUI()
    this.initializeRouteFallback()
    this.initializeErrorHandler()
  }

  private initializeRoutes(routes: Routes[]) {
    routes.forEach((route) => {
      route.initRoutes()
      this.app.route('/api', route.controller)
    })

    this.app.route('/', Home)
  }

  private initializeGlobalMiddlewares() {
    this.app.use(logger())
    this.app.use(prettyJSON())
    this.app.use(cors())

    // アプリからの ?__call= パラメータのリクエストを JioSaavn 公式へ自動中継する処理
    this.app.use('*', async (c, next) => {
      const url = new URL(c.req.url)
      if (url.searchParams.has('__call')) {
        const targetUrl = `https://www.jiosaavn.com/api.php${url.search}`
        const response = await fetch(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Cookie': 'L=english;'
          }
        })

        let data: any
        try {
          data = await response.json()
        } catch {
          data = {}
        }

        // 崩れた型や欠落プロパティを整形してレスポンスを返す
        const cleanData = sanitizeJioSaavnData(data)
        return c.json(cleanData)
      }
      await next()
    })
  }

  private initializeSwaggerUI() {
    this.app.doc31('/swagger', (c) => {
      const { protocol: urlProtocol, hostname, port } = new URL(c.req.url)
      const protocol = c.req.header('x-forwarded-proto') ? `${c.req.header('x-forwarded-proto')}:` : urlProtocol

      return {
        openapi: '3.1.0',

        info: {
          version: '1.0.0',
          title: 'JioSaavn API',
          description: `# Introduction 
\nJioSaavn API, accessible at [saavn.dev](https://saavn.dev), is an unofficial API that allows users to download high-quality songs from [JioSaavn](https://jiosaavn.com). 
It offers a fast, reliable, and easy-to-use API for developers. \n`
        },
        servers: [{ url: `${protocol}//${hostname}${port ? `:${port}` : ''}`, description: 'Current environment' }]
      }
    })

    this.app.get(
      '/docs',
      apiReference({
        pageTitle: 'JioSaavn API Documentation',
        theme: 'deepSpace',
        isEditable: false,
        layout: 'modern',
        darkMode: true,
        metaData: {
          applicationName: 'JioSaavn API',
          author: 'Sumit Kolhe',
          creator: 'Sumit Kolhe',
          publisher: 'Sumit Kolhe',
          robots: 'index, follow',
          description:
            'JioSaavn API is an unofficial wrapper written in TypeScript for jiosaavn.com providing programmatic access to a vast library of songs, albums, artists, playlists, and more.'
        },
        url: '/swagger'
      })
    )
  }

  private initializeRouteFallback() {
    this.app.notFound((ctx) => {
      return ctx.json({ success: false, message: 'route not found, check docs at https://saavn.dev/docs' }, 404)
    })
  }

  private initializeErrorHandler() {
    this.app.onError((err, ctx) => {
      const error = err as HTTPException
      return ctx.json({ success: false, message: error.message }, error.status || 500)
    })
  }

  public getApp() {
    return this.app
  }
}
