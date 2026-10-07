CREATE OR REPLACE FUNCTION public.platform_stats()
RETURNS json
LANGUAGE sql
STABLE
SECURITY INVOKER
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