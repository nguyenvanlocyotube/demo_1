CREATE POLICY "Anyone can upload recognition images"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'recognition-images');

CREATE POLICY "Anyone can read recognition images"
ON storage.objects FOR SELECT
USING (bucket_id = 'recognition-images');

CREATE POLICY "Anyone can delete recognition images"
ON storage.objects FOR DELETE
USING (bucket_id = 'recognition-images');