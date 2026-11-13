-- The codec of a video's first video track, as the sample-entry fourcc from
-- its container (`avc1`, `hvc1`, `av01`, ...), read during Drive syncs so the
-- viewer can choose a player without downloading the file first. NULL means
-- not looked at yet (or not an MP4/QuickTime-family file); `unknown` means the
-- container couldn't be read, so syncs don't retry it until the content changes.
ALTER TABLE media ADD COLUMN video_codec VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL;
