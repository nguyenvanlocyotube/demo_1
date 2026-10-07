CREATE TABLE public.recognitions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('image','audio')),
  file_name text,
  image_path text,
  bytes bigint NOT NULL DEFAULT 0,
  labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary text,
  ocr_text text,
  transcript text,
  duration_ms integer,
  latency_ms integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, DELETE ON public.recognitions TO anon;
GRANT SELECT, INSERT, DELETE ON public.recognitions TO authenticated;
GRANT ALL ON public.recognitions TO service_role;

ALTER TABLE public.recognitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view recognitions"
ON public.recognitions
FOR SELECT
USING (true);

CREATE POLICY "Anyone can add recognitions"
ON public.recognitions
FOR INSERT
WITH CHECK (true);

CREATE POLICY "Anyone can delete recognitions"
ON public.recognitions
FOR DELETE
USING (true);

CREATE INDEX recognitions_created_at_idx
ON public.recognitions (created_at DESC);

CREATE OR REPLACE FUNCTION public.platform_stats()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT json_build_object(
    'total', count(*),
    'images', count(*) FILTER (WHERE kind = 'image'),
    'audios', count(*) FILTER (WHERE kind = 'audio'),
    'bytes', coalesce(sum(bytes), 0),
    'labels', coalesce(sum(jsonb_array_length(labels)), 0),
    'audio_seconds', coalesce(round(sum(coalesce(duration_ms,0)) / 1000.0), 0),
    'avg_latency_ms', coalesce(round(avg(latency_ms) FILTER (WHERE latency_ms > 0)), 0),
    'p95_latency_ms', coalesce(round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE latency_ms > 0)), 0),
    'last_hour', count(*) FILTER (WHERE created_at > now() - interval '1 hour'),
    'last_24h', count(*) FILTER (WHERE created_at > now() - interval '24 hours'),
    'last_7d', count(*) FILTER (WHERE created_at > now() - interval '7 days'),
    'active_days', (SELECT count(DISTINCT date_trunc('day', created_at)) FROM public.recognitions),
    'last_at', max(created_at)
  )
  FROM public.recognitions;
$$;

GRANT EXECUTE ON FUNCTION public.platform_stats()
TO anon, authenticated, service_role;