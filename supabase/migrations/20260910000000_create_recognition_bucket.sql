-- Bucket bị thiếu trong các migration cũ -> uploadImage() luôn thất bại im lặng.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('recognition-images', 'recognition-images', false, 15728640,
        ARRAY['image/png','image/jpeg','image/webp','image/gif'])
ON CONFLICT (id) DO NOTHING;
