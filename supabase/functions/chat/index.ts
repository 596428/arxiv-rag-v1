// arXiv RAG Chat Edge Function
// POST /functions/v1/chat
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { embedQuery } from './embedder.ts';
import { generateAnswer } from './generator.ts';
import type { ChatRequest, ChatResponse, Source } from './types.ts';

// Security: Rate limiting config
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10; // 10 requests per minute per IP
const MAX_QUERY_LENGTH = 500; // Max query length in characters
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

// CORS headers - restrict to known origins in production
const corsHeaders = {
  'Access-Control-Allow-Origin': '*', // TODO: restrict to github.io domain
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Rate limiter function
function checkRateLimit(clientIP: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const record = rateLimitMap.get(clientIP);

  if (!record || now > record.resetTime) {
    // New window
    rateLimitMap.set(clientIP, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - 1 };
  }

  if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, remaining: 0 };
  }

  record.count++;
  return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - record.count };
}

// Get client IP from request
function getClientIP(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
         req.headers.get('x-real-ip') ||
         'unknown';
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const totalStart = performance.now();

  try {
    // Security: Rate limiting
    const clientIP = getClientIP(req);
    const rateLimit = checkRateLimit(clientIP);

    if (!rateLimit.allowed) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded. Please wait a minute.' }),
        {
          status: 429,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Retry-After': '60',
            'X-RateLimit-Remaining': '0'
          }
        }
      );
    }

    // Parse request
    const { query, embedding_model = 'openai', history = [], top_k = 5 }: ChatRequest = await req.json();

    // Security: Input validation
    if (!query || query.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: 'Query is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Security: Query length limit
    if (query.length > MAX_QUERY_LENGTH) {
      return new Response(
        JSON.stringify({ error: `Query too long. Maximum ${MAX_QUERY_LENGTH} characters allowed.` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get API keys from environment
    const openaiKey = Deno.env.get('OPENAI_API_KEY');
    const geminiKey = Deno.env.get('GEMINI_API_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    if (!openaiKey) throw new Error('OPENAI_API_KEY not configured');
    if (!geminiKey) throw new Error('GEMINI_API_KEY not configured');

    // Initialize Supabase client
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Step 1: Embed query using OpenAI
    const embedStart = performance.now();
    const { embedding: queryEmbedding, time_ms: embedTime } = await embedQuery(query, openaiKey);

    // Step 2: Vector search using match_chunks_openai
    const searchStart = performance.now();
    const { data: chunks, error: searchError } = await supabase.rpc('match_chunks_openai', {
      query_embedding: queryEmbedding,
      match_count: top_k
    });

    if (searchError) {
      throw new Error(`Search error: ${searchError.message}`);
    }

    const searchTime = Math.round(performance.now() - searchStart);

    // Step 3: Get paper titles for sources
    const paperIds = [...new Set((chunks || []).map((c: any) => c.paper_id))];
    let paperTitles: Record<string, string> = {};

    if (paperIds.length > 0) {
      const { data: papers } = await supabase
        .from('papers')
        .select('arxiv_id, title')
        .in('arxiv_id', paperIds);

      if (papers) {
        paperTitles = Object.fromEntries(papers.map((p: any) => [p.arxiv_id, p.title]));
      }
    }

    // Format sources with actual paper titles
    const sources: Source[] = (chunks || []).map((chunk: any) => ({
      paper_id: chunk.paper_id,
      title: paperTitles[chunk.paper_id] || 'Research Paper',
      section: chunk.section_title || 'Unknown Section',
      similarity: chunk.similarity || 0,
      chunk_text: chunk.content?.substring(0, 500) || '',
    }));

    // Step 4: Generate answer with Gemini
    const { answer, time_ms: generateTime } = await generateAnswer(
      query,
      sources,
      history,
      geminiKey
    );

    const totalTime = Math.round(performance.now() - totalStart);

    // Build response
    const response: ChatResponse = {
      answer,
      sources,
      metrics: {
        embed_time_ms: embedTime,
        search_time_ms: searchTime,
        generate_time_ms: generateTime,
        total_time_ms: totalTime,
        chunks_found: sources.length,
        embedding_model,
      },
    };

    return new Response(JSON.stringify(response), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'X-RateLimit-Remaining': String(rateLimit.remaining)
      },
    });

  } catch (error) {
    console.error('Chat error:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
