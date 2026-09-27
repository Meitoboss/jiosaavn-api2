import { OpenAPIHono } from '@hono/zod-openapi'
import { apiReference } from '@scalar/hono-api-reference'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { prettyJSON } from 'hono/pretty-json'
import { Home } from './pages/home'
import type { Routes } from '#common/types'
import type { HTTPException } from 'hono/http-exception'

// すべてのネストされたデータを走査し、undefined や null を安全な型に変換する関数
function deepSanitize(obj: any): any {
  if (obj === null || obj === undefined) return {}
  if (typeof obj !== 'object') return obj

  if (Array.isArray(obj)) {
    return obj.map((item) => deepSanitize(item))
  }

  const sanitized: any = { ...obj }

  // アプリが .map() を呼ぶ可能性のある主要な配列キーを確実に配列化
  const arrayKeys = [
    'results', 'songs', 'albums', 'artists', 'playlists',
    'topSongs', 'singles', 'topquery', 'data', 'list', 'featured_artists'
  ]
  
  for (const key of arrayKeys) {
    if (key in sanitized) {
      if (!Array.isArray(sanitized[key])) {
        if (sanitized[key] && typeof sanitized[key] === 'object' && Array.isArray(sanitized[key].data)) {
          sanitized[key].data = deepSanitize(sanitized[key].data)
        } else {
          sanitized[key] = []
        }
      }
    }
  }

  // アーティスト画面・曲画面で必須の配列プロパティを保証
  if (!Array.isArray(sanitized.topSongs)) sanitized.topSongs = []
  if (!Array.isArray(sanitized.albums)) sanitized.albums = []
  if (!Array.isArray(sanitized.singles)) sanitized.singles = []
  if (!Array.isArray(sanitized.results)) sanitized.results = []

  // 文字列プロパティが boolean(false) などで返ってきた場合の補正
  const stringKeys = ['image', 'title', 'song', 'name', 'subtitle', 'type', 'perma_url', 'singers', 'music']
  for (const key of stringKeys) {
    if (key in sanitized && typeof sanitized[key] !== 'string') {
      sanitized[key] = ''
    }
  }

  // ネストされたオブジェクトも再帰的に補正
  for (const key in sanitized) {
    if (sanitized[key] && typeof sanitized[key] === 'object') {
      sanitized[key] = deepSanitize(sanitized[key])
    }
  }

  return sanitized
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

        try {
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

          const cleanData = deepSanitize(data)
          return c.json(cleanData)
        } catch {
          return c.json({ results: [], songs: [], topSongs: [], albums: [] })
        }
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
