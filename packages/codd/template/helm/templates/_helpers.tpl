{{- define "mongo.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "mongo.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end -}}

{{- define "mongo.labels" -}}
helm.sh/chart: {{ include "mongo.chart" . }}
{{ include "mongo.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "mongo.selectorLabels" -}}
app.kubernetes.io/name: mongo
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
