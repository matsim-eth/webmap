import { useQuery } from "@tanstack/react-query";
import { checkAuth, redirectToLogin } from "../utils/auth";

export default function AuthGuard({ children }) {
  const { data: isAuthed, isLoading } = useQuery({
    queryKey: ['auth-check'],
    queryFn: async () => {
      const ok = await checkAuth();
      if (!ok) redirectToLogin();
      return ok;
    },
    retry: false,
  });

  if (isLoading || !isAuthed) return null;
  return children;
}
