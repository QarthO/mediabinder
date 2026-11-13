-- Videos waiting for their codec: the Drive worker looks for them every few
-- seconds, and the sync status counts them for the person's progress toast.
-- Every image has a NULL codec too, so the lookup leads with the MIME type.
ALTER TABLE media ADD INDEX media_codec_pending (mime_type, video_codec, available, user_id);
