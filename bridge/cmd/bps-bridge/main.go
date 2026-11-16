// bps-bridge performs local protocol conversion only. Credentials and network
// operations stay in the Magpie plugin host, including its proxy context.
package main

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"

	"github.com/pdxxxx/bps-magpie/bridge/internal/basispoints"
)

const maxFrame = 128 << 20

func frame(in *bufio.Reader, target any) error {
	var data []byte
	for {
		part, more, err := in.ReadLine()
		if err != nil {
			return err
		}
		if len(data)+len(part) > maxFrame {
			return errors.New("bridge request exceeds 128 MiB")
		}
		data = append(data, part...)
		if !more {
			break
		}
	}
	return json.Unmarshal(data, target)
}

func run(in *bufio.Reader, out io.Writer) error {
	var request struct {
		Protocol       int    `json:"protocol"`
		Raw            []byte `json:"raw"`
		Scope          string `json:"scope"`
		Compact        bool   `json:"compact"`
		Previous       []byte
		Terminal       []byte
		Catalog        []byte
		KeepContext    bool
		PromptCacheKey string
	}
	if err := frame(in, &request); err != nil {
		return errors.New("invalid bridge request")
	}
	if request.Protocol != 0 && request.Protocol != 2 && request.Protocol != 3 {
		return errors.New("unsupported bridge protocol")
	}
	if len(request.Raw) > 64<<20 {
		return errors.New("request exceeds 64 MiB")
	}
	var err error
	request.Raw, err = expandContinuation(request.Raw, request.Previous, request.Terminal)
	if err != nil {
		return err
	}
	// Default compatibility applies to expanded history before caching, compaction
	// or uploads. The adapter preserves opaque reasoning/compaction state and
	// rejects unreadable current tasks instead of silently discarding them.
	request.Raw, err = basispoints.StripEncryptedContent(request.Raw)
	if err != nil {
		return err
	}
	snapshot := []byte{}
	if request.KeepContext {
		snapshot, err = contextSnapshot(request.Raw, request.Compact)
		if err != nil {
			return err
		}
		if len(snapshot) > 4<<20 {
			snapshot = []byte{}
		}
	}
	if request.Compact {
		var err error
		request.Raw, err = compactRequest(request.Raw)
		if err != nil {
			return err
		}
	}
	plan, err := basispoints.PrepareNativeImages(request.Raw)
	if err != nil {
		return err
	}
	var replay basispoints.ReplayCache
	if len(request.Catalog) > 1<<20 || (len(request.Catalog) > 0 && (!json.Valid(request.Catalog) || request.Catalog[0] != '[')) {
		return errors.New("invalid inherited tool catalog")
	}
	state := &requestCatalog{scope: request.Scope, raw: request.Catalog}
	_, catalog := basispoints.NewPersistentCaches(context.Background(), state)
	// Validate the entire request, tool catalog and images before any upload.
	body, bridge, err := plan.PrepareWithCatalog(request.Scope, &replay, catalog)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(out)
	var attachments basispoints.AttachmentCache
	uploaded, err := plan.Upload(context.Background(), &attachments, request.Scope, func(ctx context.Context, a basispoints.InlineAttachment) (string, error) {
		body, contentType, _, err := a.Multipart()
		if err != nil {
			return "", err
		}
		raw, err := io.ReadAll(io.LimitReader(body, 24<<20))
		if err != nil {
			return "", err
		}
		if err = enc.Encode(map[string]any{"kind": "upload", "body": raw, "contentType": contentType, "cacheKey": a.CacheKey()}); err != nil {
			return "", err
		}
		var answer struct {
			ID    string `json:"id"`
			Error string `json:"error"`
		}
		if err = frame(in, &answer); err != nil {
			return "", err
		}
		if answer.Error != "" {
			return "", errors.New("attachment upload failed")
		}
		return answer.ID, nil
	})
	if err != nil {
		return err
	}
	if plan.HasImages() {
		body, bridge, err = bridge.Reprepare(uploaded)
		if err != nil {
			return err
		}
	}
	protocol := 2
	if request.PromptCacheKey != "" {
		if len(request.PromptCacheKey) != 36 || request.PromptCacheKey[:4] != "bps-" {
			return errors.New("invalid host prompt cache key")
		}
		if _, err := hex.DecodeString(request.PromptCacheKey[4:]); err != nil {
			return errors.New("invalid host prompt cache key")
		}
		var prepared map[string]any
		if err = json.Unmarshal(body, &prepared); err != nil {
			return err
		}
		prepared["prompt_cache_key"] = request.PromptCacheKey
		if body, err = json.Marshal(prepared); err != nil {
			return err
		}
	}
	if request.Protocol == 3 {
		protocol = 3
	}
	if err = enc.Encode(map[string]any{"kind": "request", "protocol": protocol, "body": body, "context": snapshot, "catalog": state.raw, "effort": bridge.Effort, "warnings": bridge.Warnings}); err != nil {
		return err
	}
	// An already-loaded host may still use protocol 2 during a local update.
	if protocol == 2 {
		stream := bridge.Stream(io.NopCloser(in))
		defer stream.Close()
		if _, err = io.Copy(out, stream); err != nil {
			return errStream
		}
		return nil
	}
	output := &framedOutput{enc: enc}
	upstream := &framedInput{in: in}
	repairBody := body
	stream := bridge.StreamWithToolRepair(context.Background(), upstream, func(ctx context.Context, failed map[string]any, validation error) (map[string]any, error) {
		request, err := basispoints.BuildToolRepairRequest(repairBody, failed, validation)
		if err != nil {
			return nil, err
		}
		if len(request) > 64<<20 {
			return nil, errors.New("BPS correction request exceeds 64 MiB")
		}
		if err = output.control(map[string]any{"kind": "repair", "body": request}); err != nil {
			return nil, err
		}
		// The host stops the prior HTTP body before starting this continuation.
		if err = upstream.drain(); err != nil {
			return nil, err
		}
		repairBody = request
		upstream = &framedInput{in: in}
		response, readErr := basispoints.ReadToolRepairResponse(upstream)
		if err = output.control(map[string]any{"kind": "repair_done"}); err != nil {
			return response, err
		}
		if err = upstream.drain(); readErr == nil {
			readErr = err
		}
		return response, readErr
	})
	defer stream.Close()
	if _, err = io.Copy(output, stream); err != nil {
		return errStream
	}
	return nil
}

var errStream = errors.New("BPS stream did not complete")
var version = "development"

func main() {
	if len(os.Args) > 1 {
		if len(os.Args) == 2 && os.Args[1] == "--version" {
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"version": version, "protocol": 3})
			return
		}
		os.Exit(2)
	}
	if err := run(bufio.NewReaderSize(os.Stdin, 64<<10), os.Stdout); err != nil {
		// Never print payloads or tokens. Once SSE has started the bridge supplies
		// its own failure event; exit status also prevents silent truncation.
		if !errors.Is(err, errStream) {
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"kind": "error", "message": err.Error()})
		}
		os.Exit(1)
	}
}
