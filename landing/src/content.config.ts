import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'
import { z } from 'astro/zod'

const docs = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/docs' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    section: z.enum([
      'start',
      'agent',
      'customize',
      'tools',
      'concepts',
      'reference',
      'troubleshooting'
    ]),
    order: z.number().int().positive(),
    type: z.enum(['quickstart', 'guide', 'concept', 'reference', 'troubleshooting']),
    audience: z.string().min(1),
    owner: z.string().min(1),
    sources: z.array(z.string().min(1)).min(1),
    lastVerified: z.string().regex(/^\d+\.\d+\.\d+$/),
    related: z.array(z.string().min(1)).default([])
  })
})

export const collections = { docs }
