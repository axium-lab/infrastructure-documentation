import com.google.auth.oauth2.AccessToken;
import com.google.auth.oauth2.GoogleCredentials;
import com.google.genai.Client;
import com.google.genai.types.GenerateContentConfig;
import com.google.genai.types.GenerateContentResponse;
import com.google.genai.types.HttpOptions;

public class Main {
  public static void main(String[] args) {
    Client ai = Client.builder()
        .vertexAI(true)
        .project("lo-que-sea")
        .location("global")
        // En Java, .apiKey() es mutuamente excluyente con project/location: se pasa
        // el token de Axium como credencial estatica (evita ADC y anade el Bearer).
        .credentials(GoogleCredentials.create(
            new AccessToken("ax_34d7b1add3da3ceb7d67e6035ae75183e29b1911", null)))
        .httpOptions(HttpOptions.builder()
            .baseUrl("https://axium-core.a.run.app/v1/proxy-apps/686f2125-be80-45f6-b559-f96163924c29/vertex")
            .build())
        .build();

    GenerateContentResponse response = ai.models.generateContent(
        "google/gemini-3.5-flash-lite",
        "Que modelo eres?",
        GenerateContentConfig.builder().seed(42).build());

    System.out.println(response.text());
  }
}
