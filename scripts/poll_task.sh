#!/bin/bash
# Boucle de suivi get_task toutes les ~10 secondes jusqu'à completed ou failed (max 8 min)
TASK_ID="$1"
for i in $(seq 1 48); do
  RESP=$(curl -s --max-time 30 -X POST http://localhost:3000/mcp \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":100,\"method\":\"tools/call\",\"params\":{\"name\":\"get_task\",\"arguments\":{\"task_id\":\"$TASK_ID\"}}}")
  TEXT=$(echo "$RESP" | sed -n 's/^data: //p' | head -1 | python3 -c "
import json,sys
try:
    obj=json.loads(sys.stdin.read())
    print(obj.get('result',{}).get('content',[{}])[0].get('text','').replace(chr(10),' | '))
except Exception as e:
    print('PARSE_ERR', e)")
  echo "[$i] $(date +%H:%M:%S) → $TEXT"
  case "$TEXT" in
    *"تم إنشاء الفيديو بنجاح"*|*"تم إنشاء الصورة بنجاح"*|*"تم دمج المقاطع بنجاح"*|*"فشلت المهمة"*) echo "=== FIN ==="; break;;
  esac
  sleep 10
done
