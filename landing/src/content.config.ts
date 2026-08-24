import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'
import { z } from 'astro/zod'
import { DOC_SECTIONS } from './lib/sections'

const docs = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/docs' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    section: z.enum(DOC_SECTIONS),
    order: z.number().int().positive(),
    type: z.enum(['quickstart', 'guide', 'concept', 'reference', 'troubleshooting']),
    audience: z.string().min(1),
    related: z.array(z.string().min(1)).default([])
  })
})

/** Docs collection for the landing site. */
export const collections = { docs }
